import { ColabError } from "../domain/errors.js"
import type { ToolHandler } from "../tools/types.js"
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

type EditOp = NonNullable<Parameters<ToolHandler<"edit">["run"]>[0]["ops"]>[number]

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

export type EditArgs = Parameters<ToolHandler<"edit">["run"]>[0]

export interface NotebookEditFile {
  assertMissing(): Promise<void>
  readExisting(): Promise<Uint8Array>
  commit(bytes: Uint8Array, before?: string): Promise<void>
}

export async function editMetadata(input: EditArgs) {
  return { path: input.path, ops: [...new Set(input.ops.map((op) => op.op))], operations: input.ops.length }
}

/** Apply notebook operations behind a caller-provided filesystem boundary. */
export async function applyNotebookEdit(input: EditArgs, path: string, file: NotebookEditFile) {
  const first = input.ops[0]!
  let notebook: Notebook
  let before: string | undefined
  if (first.op === "create") {
    await file.assertMissing()
    notebook = createNotebook({
      kernel: first.kernel,
      cells: (first.cells ?? []).map((cell) => ({
        type: cell.type,
        source: cell.source,
        ...(cell.metadata !== undefined ? { metadata: cell.metadata as unknown as JsonObject } : {}),
      })),
    })
  } else {
    const bytes = await file.readExisting()
    before = notebookHash(bytes)
    if (input.ifHash !== before) throw changed("The notebook's bytes differ from the ifHash this call passed.")
    notebook = parseNotebook(bytes)
  }
  for (const op of input.ops) if (op.op !== "create") applyOp(notebook, op)
  if (!notebook.changed && before !== undefined) return { state: "ok" as const, path, hash: before, cells: notebook.cells.length }
  const bytes = serializeNotebook(notebook)
  await file.commit(bytes, before)
  return { state: "ok" as const, path, hash: notebookHash(bytes), cells: notebook.cells.length }
}

export function changed(detail = "Another process changed the notebook before this edit could be written.") {
  return new ColabError("NOTEBOOK_CHANGED", detail, { next: "Read it again with colab_notebook, then edit with the hash it returns." })
}
