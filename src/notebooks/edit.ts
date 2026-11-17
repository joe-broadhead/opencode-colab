/**
 * `colab_edit` (design §6): local notebook edits, all or nothing. `create`, `insert`, `replace`, `delete`, `move`,
 * `clearOutputs` and `setMetadata`, applied in order to one in-memory model and written once, atomically. Every edit but
 * the `create`-first form takes `ifHash`, the hash `colab_notebook` returned, and a file that moved is
 * `NOTEBOOK_CHANGED` with nothing written.
 *
 * Two guards, because `ifHash` alone loses an edit when two calls overlap (review M1): the whole read → check → write
 * runs under the per-path lock `lock.ts` holds (the same lock `NotebookStore.mergeRun` takes), and the file is re-read
 * and re-hashed immediately before the rename, which narrows the cross-process window to the rename itself. A `create`
 * whose path appeared meanwhile answers `FILE_EXISTS`.
 *
 * The tool asserts `colab.edit` before it runs (the wrapper) and asks OpenCode's `edit` on the path, plus
 * `external_directory` outside the project, through the handler context (H8).
 */
import { ColabError } from "../domain/errors.js"
import type { HandlerContext, ToolHandler } from "../tools/types.js"
import { withNotebookLock } from "./lock.js"
import {
  clearCellOutputs,
  createNotebook,
  findCellIndex,
  insertCell,
  moveCell,
  notebookHash,
  parseNotebook,
  removeCell,
  replaceSource,
  selectCellIndices,
  serializeNotebook,
  setCellMetadata,
  setNotebookMetadata,
  type JsonObject,
  type Notebook,
} from "./model.js"
import { assertHostEdits } from "./permissions.js"
import { exists, readOptionalFile, readWorkspaceFile, refuseExisting, resolveWorkspacePath, writeWorkspaceFile, type WorkspaceTarget } from "./paths.js"

type EditOp = NonNullable<Parameters<ToolHandler<"edit">["run"]>[0]["ops"]>[number]

const displayPath = (target: WorkspaceTarget) => (target.insideProject ? target.relative : target.absolute)

function insertPosition(notebook: Notebook, at: Extract<EditOp, { op: "insert" }>["at"]): number {
  if (typeof at === "number") return at
  if ("after" in at) return findCellIndex(notebook, at.after) + 1
  return findCellIndex(notebook, at.before)
}

function applyOp(notebook: Notebook, op: EditOp): void {
  switch (op.op) {
    case "create":
      throw new ColabError("INPUT_INVALID", "create is only the first operation.")
    case "insert":
      insertCell(notebook, insertPosition(notebook, op.at), {
        type: op.cell.type,
        source: op.cell.source,
        ...(op.cell.metadata !== undefined ? { metadata: op.cell.metadata as unknown as JsonObject } : {}),
      })
      return
    case "replace":
      replaceSource(notebook, findCellIndex(notebook, op.cell), op.source)
      return
    case "delete":
      removeCell(notebook, findCellIndex(notebook, op.cell))
      return
    case "move":
      moveCell(notebook, findCellIndex(notebook, op.cell), op.to)
      return
    case "clearOutputs":
      for (const index of selectCellIndices(notebook, op.cells)) clearCellOutputs(notebook, index)
      return
    case "setMetadata":
      if (op.cell === undefined) setNotebookMetadata(notebook, op.metadata as unknown as JsonObject)
      else setCellMetadata(notebook, findCellIndex(notebook, op.cell), op.metadata as unknown as JsonObject)
      return
  }
}

export const edit: ToolHandler<"edit"> = {
  async metadata(input) {
    return { path: input.path, ops: [...new Set(input.ops.map((op) => op.op))], operations: input.ops.length }
  },

  async run(input, ctx: HandlerContext) {
    const target = await resolveWorkspacePath(input.path, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
    await assertHostEdits(ctx, target)

    return withNotebookLock(target.absolute, async () => {
      const first = input.ops[0]!
      let notebook: Notebook
      let before: string | undefined

      if (first.op === "create") {
        if (await exists(target)) refuseExisting(target, "Read it with colab_notebook and pass ifHash, or choose another path.")
        notebook = createNotebook({
          kernel: first.kernel,
          cells: (first.cells ?? []).map((cell) => ({
            type: cell.type,
            source: cell.source,
            ...(cell.metadata !== undefined ? { metadata: cell.metadata as unknown as JsonObject } : {}),
          })),
        })
      } else {
        const bytes = await readWorkspaceFile(target, ctx.deps.options.maxDownloadBytes)
        before = notebookHash(bytes)
        if (input.ifHash !== before) {
          throw new ColabError("NOTEBOOK_CHANGED", "The notebook's bytes differ from the ifHash this call passed.", { next: "Read it again with colab_notebook, then edit with the hash it returns." })
        }
        notebook = parseNotebook(bytes)
      }

      for (const op of input.ops) {
        if (op.op === "create") continue
        applyOp(notebook, op)
      }

      // Nothing changed: leave the bytes exactly as they are.
      if (!notebook.changed && before !== undefined) {
        return { state: "ok" as const, path: displayPath(target), hash: before, cells: notebook.cells.length }
      }

      const bytes = serializeNotebook(notebook)
      // Cross-process guard: the file must still be the one this call read (or still absent for a create).
      const current = await readOptionalFile(target)
      if (before === undefined) {
        if (current !== undefined) refuseExisting(target, "Read it with colab_notebook and pass ifHash, or choose another path.")
      } else if (current === undefined || notebookHash(current) !== before) {
        throw new ColabError("NOTEBOOK_CHANGED", "Another process changed the notebook before this edit could be written.", { next: "Read it again with colab_notebook, then edit with the hash it returns." })
      }
      await writeWorkspaceFile(target, bytes)
      return { state: "ok" as const, path: displayPath(target), hash: notebookHash(bytes), cells: notebook.cells.length }
    })
  },
}
