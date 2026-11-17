/**
 * Package C's `NotebookStore` (design §9.3, the review's contract request 2): package D's write-back reads the cells
 * `colab_notebook` shows (derived ids included) and merges a run's outputs by cell id into the file as it is now. The
 * merge holds the same per-path lock `colab_edit` holds (`lock.ts`), so a write-back and an edit cannot overwrite each
 * other; a run cell that changed, or a file that moved, answers `NOTEBOOK_CHANGED` with nothing written. D asserts the
 * host's `edit` before it calls here.
 */
import type { PortEnv } from "../deps.js"
import type { NotebookStore } from "../ports.js"
import { withNotebookLock } from "./lock.js"
import { cellSource, cellType, mergeRunOutputs, notebookHash, parseNotebook, serializeNotebook, type RunCell } from "./model.js"
import { readWorkspaceFile, resolveWorkspacePath, writeWorkspaceFile } from "./paths.js"

export function createNotebookStore(env: PortEnv): NotebookStore {
  return {
    async read(path, signal) {
      signal.throwIfAborted()
      const target = await resolveWorkspacePath(path, { directory: env.directory, allowedRoots: env.options.allowedRoots })
      const bytes = await readWorkspaceFile(target, env.options.maxDownloadBytes)
      const notebook = parseNotebook(bytes)
      signal.throwIfAborted()
      return { hash: notebookHash(bytes), cells: notebook.cells.map((cell) => ({ id: cell.id, type: cellType(cell), source: cellSource(cell) })) }
    },

    async mergeRun(path, input, signal) {
      signal.throwIfAborted()
      const target = await resolveWorkspacePath(path, { directory: env.directory, allowedRoots: env.options.allowedRoots })
      return withNotebookLock(target.absolute, async () => {
        const bytes = await readWorkspaceFile(target, env.options.maxDownloadBytes)
        const notebook = parseNotebook(bytes)
        mergeRunOutputs(notebook, input.cells as unknown as readonly RunCell[], input.outputDir)
        const next = serializeNotebook(notebook)
        signal.throwIfAborted()
        await writeWorkspaceFile(target, next)
        return { hash: notebookHash(next) }
      })
    },
  }
}
