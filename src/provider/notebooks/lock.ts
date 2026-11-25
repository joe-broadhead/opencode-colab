/**
 * One in-process lock per notebook path (design §9.3, review M1): `colab_edit`, and later the `NotebookStore`'s
 * `mergeRun`, serialize read → check → write on the same file, so two calls in one process can never both pass
 * `ifHash` and lose one edit. A second call waits, then re-reads and answers `NOTEBOOK_CHANGED` when the first moved the
 * file. The lock is keyed by the normalized absolute path; the cross-process guard stays `ifHash` plus the re-read
 * before the rename.
 *
 * The map holds only the tails of chains that are still running, so a process that edits many notebooks does not grow it
 * without bound.
 */
const tails = new Map<string, Promise<unknown>>()

/** Runs `task` with the lock for `absolute` held, in call order. A task's failure never blocks the next waiter. */
export async function withNotebookLock<T>(absolute: string, task: () => Promise<T>): Promise<T> {
  const previous = tails.get(absolute) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(task)
  const tail = run.catch(() => undefined)
  tails.set(absolute, tail)
  try {
    return await run
  } finally {
    if (tails.get(absolute) === tail) tails.delete(absolute)
  }
}
