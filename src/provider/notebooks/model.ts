/**
 * The nbformat 4 model (design §5, §15.1): parse and validate a notebook, address cells by id or index, derive the ids
 * missing in a 4.0–4.4 notebook in memory, apply the `colab_edit` operations, merge a run's outputs back by cell id,
 * and serialize.
 *
 * Sources and text mime values are rejoined on read and split on write exactly as nbformat's JSON reader and writer do
 * (`nbformat/v4/rwbase.py`: `rejoin_lines`, `split_lines`, `strip_transient`; `nbformat/v4/nbjson.py`: `JSONWriter` with
 * `indent=1`, `sort_keys=True` and no trailing newline), so a notebook this model rewrites reads the same in Jupyter.
 * A file no edit touched is returned byte for byte: the model keeps the bytes it read and `serializeNotebook` hands
 * them back untouched.
 *
 * Ids: nbformat 4.5 requires `id` on every cell (nbformat.v4.5.schema.json, `cell_id`: `^[a-zA-Z0-9-_]+$`, at most 64
 * characters); 4.0–4.4 have none. An absent id is derived from the cell's index and source when the notebook is read
 * and kept for the life of that model, so a call's references stay stable across inserts; `colab_edit` persists the ids
 * and raises `nbformat_minor` to 5, and no read ever writes.
 */
import { createHash } from "node:crypto"
import { ColabError } from "../../domain/errors.js"

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type JsonObject = { [key: string]: JsonValue }

export type CellType = "code" | "markdown" | "raw"

/** One cell: its disk object, the id it answers to, and whether that id came from the file or was derived. */
export interface NotebookCell {
  readonly json: JsonObject
  readonly id: string
  readonly derived: boolean
}

export interface Notebook {
  nbformatMinor: number
  readonly metadata: JsonObject
  readonly cells: NotebookCell[]
  /** The bytes the model read; `serializeNotebook` returns them while nothing changed. */
  readonly raw?: Uint8Array
  /** The file holds an integer JSON cannot keep exactly, so the model refuses to rewrite it (review LOW 4). */
  readonly lossy: boolean
  changed: boolean
}

export interface NewCell {
  readonly type: CellType
  readonly source: string
  readonly metadata?: JsonObject
}

/** One cell a run reports back: its id, the source it had at run start, and what to write. */
export interface RunCell {
  readonly id: string
  readonly source: string
  readonly outputs: readonly JsonObject[]
  readonly executionCount: number | null
}

const MAX_MINOR = 5
const CELL_ID = /^[a-zA-Z0-9_-]{1,64}$/
const TRANSIENT_NOTEBOOK_KEYS = ["orig_nbformat", "orig_nbformat_minor", "signature"] as const

/** A sha256 as `colab_notebook` returns it: the shape `ifHash` takes. */
export function notebookHash(bytes: Uint8Array): string {
  return `sha256:${hashBytes(bytes)}`
}

/** The bare hex sha256, for a sync record's `baseHash` and an upload's `sha256` result. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

/** The id a cell without one answers to: a stable hash of its index and source (design §5). */
export function deriveCellId(index: number, source: string): string {
  return createHash("sha256").update(`${index}\n${source}`, "utf8").digest("hex").slice(0, 16)
}

function invalid(detail: string): never {
  throw new ColabError("NOTEBOOK_INVALID", `This is not an nbformat 4 notebook: ${detail}.`)
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function joinedText(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("")
  return undefined
}

const isJsonMime = (mime: string) => mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"))
const isTextMime = (mime: string) => mime.startsWith("text/") || mime === "application/javascript" || mime === "image/svg+xml"

/** Rejoin a mimebundle's split values (nbformat's `_rejoin_mimebundle`). */
function rejoinMimebundle(bundle: unknown): void {
  if (!isObject(bundle)) return
  for (const [mime, value] of Object.entries(bundle)) {
    if (isJsonMime(mime)) continue
    const text = joinedText(value)
    if (text !== undefined) bundle[mime] = text
  }
}

/** Split a mimebundle's text values into lines (nbformat's `_split_mimebundle`). */
function splitMimebundle(bundle: unknown): JsonValue {
  if (!isObject(bundle)) return bundle as JsonValue
  const out: JsonObject = {}
  for (const [mime, value] of Object.entries(bundle)) {
    out[mime] = isTextMime(mime) && typeof value === "string" ? splitLines(value) : (value as JsonValue)
  }
  return out
}

function rejoinOutput(output: JsonObject): void {
  if (output.output_type === "stream" && typeof output.text !== "string") {
    const text = joinedText(output.text)
    if (text !== undefined) output.text = text
  }
  if ((output.output_type === "execute_result" || output.output_type === "display_data" || output.output_type === "update_display_data") && isObject(output.data)) rejoinMimebundle(output.data)
}

function splitOutput(output: JsonValue): JsonValue {
  if (!isObject(output)) return output
  const out: JsonObject = { ...output }
  if (out.output_type === "stream" && typeof out.text === "string") out.text = splitLines(out.text)
  if ((out.output_type === "execute_result" || out.output_type === "display_data" || out.output_type === "update_display_data") && isObject(out.data)) out.data = splitMimebundle(out.data)
  return out
}

/**
 * Python's `str.splitlines(True)` for the line endings notebooks use: `\n`, `\r\n` and `\r`. Python also breaks on
 * `\v`, `\f`, `\x1c`–`\x1e`, `\x85`, `\u2028` and `\u2029`; those stay inside one line here, which rejoins to the
 * same text, so a file that is not rewritten keeps its bytes and a rewrite only differs in line grouping.
 */
export function splitLines(text: string): string[] {
  const lines: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i]
    if (character === "\n") {
      lines.push(text.slice(start, i + 1))
      start = i + 1
    } else if (character === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1
      lines.push(text.slice(start, end))
      i = end - 1
      start = end
    }
  }
  if (start < text.length) lines.push(text.slice(start))
  return lines
}

function stripTransient(json: JsonObject): void {
  for (const key of TRANSIENT_NOTEBOOK_KEYS) delete json[key]
}

function cleanMetadata(metadata: JsonObject): JsonObject {
  const out = cloneJson(metadata) as JsonObject
  stripTransient(out)
  return out
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item))
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const [key, item] of Object.entries(value)) out[key] = cloneJson(item)
    return out
  }
  return value
}

/**
 * Whether the JSON text holds an integer literal JSON cannot keep exactly (above 2^53 - 1, outside a string). A model
 * that read one refuses to rewrite the file: `JSON.parse` would round it, and a notebook's metadata is not ours to
 * change. Reading still works.
 */
function hasUnsafeInteger(text: string): boolean {
  let inString = false
  let escaped = false
  const outside: string[] = []
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false
      else if (character === "\\") escaped = true
      else if (character === '"') inString = false
      outside.push(" ")
      continue
    }
    if (character === '"') {
      inString = true
      outside.push(" ")
      continue
    }
    outside.push(character)
  }
  for (const match of outside.join("").matchAll(/-?\d+/g)) {
    const digits = match[0].replace(/^-/, "")
    if (digits.length < 16) continue
    try {
      const value = BigInt(match[0])
      if (value > 9007199254740991n || value < -9007199254740991n) return true
    } catch {
      // Not an integer literal after all.
    }
  }
  return false
}

/** JSON with object keys sorted, as nbformat's `sort_keys=True` writes. */
function sortKeysDeep(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => sortKeysDeep(item))
  if (isObject(value)) {
    const out: JsonObject = {}
    for (const key of Object.keys(value).sort()) out[key] = sortKeysDeep(value[key] as JsonValue)
    return out
  }
  return value
}

/** For comparing metadata merges without caring about key order. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value as JsonValue))
}

/**
 * Parses nbformat 4.0–4.5. `nbformat` must be 4 and `nbformat_minor` 0–5; a newer minor is refused rather than
 * guessed at. A missing cell `metadata`, a code cell's missing `outputs`/`execution_count` and a missing notebook
 * `metadata` take their schema defaults, so a hand-written or old notebook still opens; a present value of the wrong
 * type is refused.
 */
export function parseNotebook(bytes: Uint8Array): Notebook {
  let document: unknown
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    document = JSON.parse(text)
  } catch {
    invalid("it is not UTF-8 JSON")
  }
  if (!isObject(document)) invalid("the root is not a JSON object")
  if (document.nbformat !== 4) invalid("nbformat is not 4")
  const minor = document.nbformat_minor
  if (!Number.isInteger(minor) || (minor as number) < 0) invalid("nbformat_minor is not a non-negative integer")
  if ((minor as number) > MAX_MINOR) invalid(`nbformat_minor ${String(minor)} is newer than this plugin supports (4.${MAX_MINOR})`)
  if (!Array.isArray(document.cells)) invalid("cells is not an array")
  const metadata = document.metadata === undefined ? {} : document.metadata
  if (!isObject(metadata)) invalid("metadata is not an object")

  const cells: NotebookCell[] = []
  const seen = new Set<string>()
  document.cells.forEach((raw: unknown, index: number) => {
    if (!isObject(raw)) invalid(`cell ${index} is not an object`)
    const type = raw.cell_type
    if (type !== "code" && type !== "markdown" && type !== "raw") invalid(`cell ${index} has no nbformat 4 cell_type`)
    const source = joinedText(raw.source)
    if (source === undefined) invalid(`cell ${index} has no string source`)
    const json: JsonObject = { ...(raw as JsonObject) }
    json.source = source
    if (json.metadata === undefined) json.metadata = {}
    if (!isObject(json.metadata)) invalid(`cell ${index} metadata is not an object`)
    json.metadata = cloneJson(json.metadata) as JsonObject
    delete (json.metadata as JsonObject).trusted
    if (type === "code") {
      if (json.outputs === undefined) json.outputs = []
      if (!Array.isArray(json.outputs)) invalid(`cell ${index} outputs is not an array`)
      json.outputs = json.outputs.map((output, position) => {
        if (!isObject(output)) invalid(`cell ${index} output ${position} is not an object`)
        const copy = cloneJson(output) as JsonObject
        if (typeof copy.output_type !== "string") invalid(`cell ${index} output ${position} has no output_type`)
        rejoinOutput(copy)
        return copy
      })
      if (json.execution_count === undefined) json.execution_count = null
      if (!(json.execution_count === null || (Number.isInteger(json.execution_count) && (json.execution_count as number) >= 0))) {
        invalid(`cell ${index} execution_count is not null or a non-negative integer`)
      }
    }
    if (isObject(json.attachments)) for (const bundle of Object.values(json.attachments)) rejoinMimebundle(bundle)
    const declared = raw.id
    if (declared !== undefined && (typeof declared !== "string" || !CELL_ID.test(declared))) invalid(`cell ${index} has an invalid id`)
    const id = typeof declared === "string" ? declared : deriveCellId(index, source)
    if (seen.has(id)) invalid("two cells share the same id")
    seen.add(id)
    cells.push({ json, id, derived: typeof declared !== "string" })
  })

  return { nbformatMinor: minor as number, metadata: cloneJson(metadata) as JsonObject, cells, raw: bytes, lossy: hasUnsafeInteger(text), changed: false }
}

/**
 * Serializes the model. A notebook no operation changed returns the bytes it was parsed from. With `persistIds`
 * (the default, used by `colab_edit`) every cell is written with its id and `nbformat_minor` is raised to 5; without
 * it (the copy a Drive push uploads) only ids the file already had are written and the minor is left alone.
 */
export function serializeNotebook(notebook: Notebook, options: { readonly persistIds?: boolean } = {}): Uint8Array {
  const persistIds = options.persistIds ?? true
  if (!notebook.changed && notebook.raw) return notebook.raw
  if (notebook.lossy) {
    throw new ColabError("NOTEBOOK_INVALID", "The notebook holds an integer larger than JSON can keep exactly, so the plugin will not rewrite it.", {
      next: "Open it in Jupyter and save it there, or fix the integer by hand, then edit it with colab_edit.",
    })
  }
  const cells = notebook.cells.map((cell) => {
    const out = cloneJson(cell.json) as JsonObject
    if (cell.derived && !persistIds) delete out.id
    else out.id = cell.id
    out.source = splitLines(cellSource(cell))
    if (out.cell_type === "code" && Array.isArray(out.outputs)) out.outputs = out.outputs.map((output) => splitOutput(output))
    if (isObject(out.attachments)) {
      const attachments: JsonObject = {}
      for (const [name, bundle] of Object.entries(out.attachments)) attachments[name] = splitMimebundle(bundle)
      out.attachments = attachments
    }
    if (isObject(out.metadata)) {
      out.metadata = cloneJson(out.metadata) as JsonObject
      delete (out.metadata as JsonObject).trusted
    }
    return out
  })
  const persist = persistIds && notebook.cells.some((cell) => cell.derived)
  const document: JsonObject = { cells, metadata: cleanMetadata(notebook.metadata), nbformat: 4, nbformat_minor: persist ? Math.max(notebook.nbformatMinor, 5) : notebook.nbformatMinor }
  // nbformat's JSONWriter (indent=1, sort_keys=True), and nbformat.write() ends the file with a newline.
  return Buffer.from(`${JSON.stringify(sortKeysDeep(document), null, 1)}\n`, "utf8")
}

// ── Reading a cell ──────────────────────────────────────────────────────

export function cellType(cell: NotebookCell): CellType {
  return cell.json.cell_type as CellType
}

export function cellSource(cell: NotebookCell): string {
  return typeof cell.json.source === "string" ? cell.json.source : ""
}

export function cellOutputs(cell: NotebookCell): JsonObject[] {
  return Array.isArray(cell.json.outputs) ? (cell.json.outputs.filter(isObject) as JsonObject[]) : []
}

export function cellExecutionCount(cell: NotebookCell): number | null {
  const count = cell.json.execution_count
  return typeof count === "number" ? count : null
}

/** The kernel view: `kernelspec.name`, and the language from `kernelspec.language` or `language_info.name`. */
export function notebookKernel(notebook: Notebook): { readonly name: string; readonly language?: string } | undefined {
  const kernelspec = notebook.metadata.kernelspec
  if (!isObject(kernelspec) || typeof kernelspec.name !== "string") return undefined
  const declared = typeof kernelspec.language === "string" ? kernelspec.language : undefined
  const info = notebook.metadata.language_info
  const language = declared ?? (isObject(info) && typeof info.name === "string" ? info.name : undefined)
  return { name: kernelspec.name, ...(language !== undefined ? { language } : {}) }
}

/** The notebook `metadata.colab_origin` the foreign-origin warning reads: a string, or an object naming an author. */
export function notebookOrigin(notebook: Notebook): string | undefined {
  const origin = notebook.metadata.colab_origin
  if (typeof origin === "string") return origin
  if (isObject(origin)) {
    if (typeof origin.email === "string") return origin.email
    if (typeof origin.author === "string") return origin.author
  }
  return undefined
}

// ── Addressing ──────────────────────────────────────────────────────────

function notFound(detail: string): never {
  throw new ColabError("NOT_FOUND", detail, { next: "colab_notebook lists every cell's id and index." })
}

/** A cell reference: a 0-based index or an nbformat id (derived ids included). */
export function findCellIndex(notebook: Notebook, ref: string | number): number {
  if (typeof ref === "number") {
    if (Number.isInteger(ref) && ref >= 0 && ref < notebook.cells.length) return ref
    notFound(`There is no cell at index ${ref}.`)
  }
  const index = notebook.cells.findIndex((cell) => cell.id === ref)
  if (index === -1) notFound("No cell in this notebook has that id.")
  return index
}

/** The cells a selector names, as indices in the notebook, each once, in the order given. */
export function selectCellIndices(notebook: Notebook, selector: "all" | readonly (string | number)[] | { readonly from: string | number; readonly to: string | number } | undefined): number[] {
  if (selector === undefined || selector === "all") return notebook.cells.map((_, index) => index)
  if (Array.isArray(selector)) {
    const seen = new Set<number>()
    for (const ref of selector) seen.add(findCellIndex(notebook, ref as string | number))
    return [...seen]
  }
  const range = selector as { readonly from: string | number; readonly to: string | number }
  const from = findCellIndex(notebook, range.from)
  const to = findCellIndex(notebook, range.to)
  if (from > to) throw new ColabError("INPUT_INVALID", "A cell range's from is after its to.")
  return Array.from({ length: to - from + 1 }, (_, offset) => from + offset)
}

// ── Editing ─────────────────────────────────────────────────────────────

export function createNotebook(input: { readonly kernel?: string; readonly cells?: readonly NewCell[] }): Notebook {
  const notebook: Notebook = { nbformatMinor: 5, metadata: {}, cells: [], lossy: false, changed: true }
  for (const cell of input.cells ?? []) insertCell(notebook, notebook.cells.length, cell)
  if (input.kernel !== undefined) notebook.metadata.kernelspec = { name: input.kernel, display_name: input.kernel }
  return notebook
}

function cellJson(cell: NewCell, id: string): NotebookCell {
  const json: JsonObject = { cell_type: cell.type, metadata: cloneJson(cell.metadata ?? {}) as JsonObject, source: cell.source }
  if (cell.type === "code") {
    json.outputs = []
    json.execution_count = null
  }
  return { json, id, derived: true }
}

/** A derived id that no cell in this model already answers to (two inserts at one index can derive the same base). */
function uniqueCellId(notebook: Notebook, at: number, source: string): string {
  let id = deriveCellId(at, source)
  for (let salt = 1; notebook.cells.some((cell) => cell.id === id); salt += 1) id = deriveCellId(at, `${source}\u0000${salt}`)
  return id
}

export function insertCell(notebook: Notebook, at: number, cell: NewCell): number {
  if (!Number.isInteger(at) || at < 0 || at > notebook.cells.length) {
    throw new ColabError("INPUT_INVALID", `There is no position ${at} in a notebook of ${notebook.cells.length} cells.`, { next: "Use an index from 0 to the notebook's cell count." })
  }
  notebook.cells.splice(at, 0, cellJson(cell, uniqueCellId(notebook, at, cell.source)))
  notebook.changed = true
  return at
}

export function removeCell(notebook: Notebook, index: number): void {
  findCellIndex(notebook, index)
  notebook.cells.splice(index, 1)
  notebook.changed = true
}

export function moveCell(notebook: Notebook, from: number, to: number): void {
  findCellIndex(notebook, from)
  // nbformat's move_cell pops the cell and inserts it at `to`, so `to` may be the notebook's length (append).
  if (!Number.isInteger(to) || to < 0 || to > notebook.cells.length) {
    throw new ColabError("INPUT_INVALID", `There is no position ${to} in a notebook of ${notebook.cells.length} cells.`, { next: "Use an index from 0 to the notebook's cell count." })
  }
  if (from === to) return
  const [cell] = notebook.cells.splice(from, 1)
  notebook.cells.splice(to, 0, cell!)
  notebook.changed = true
}

export function replaceSource(notebook: Notebook, index: number, source: string): void {
  const cell = notebook.cells[findCellIndex(notebook, index)]!
  if (cellSource(cell) === source) return
  cell.json.source = source
  notebook.changed = true
}

export function clearCellOutputs(notebook: Notebook, index: number): void {
  const cell = notebook.cells[findCellIndex(notebook, index)]!
  if (cellType(cell) !== "code") return
  const outputs = cellOutputs(cell)
  const count = cellExecutionCount(cell)
  if (outputs.length === 0 && count === null) return
  cell.json.outputs = []
  cell.json.execution_count = null
  notebook.changed = true
}

function mergeMetadata(target: JsonObject, metadata: JsonObject): boolean {
  let changed = false
  for (const [key, value] of Object.entries(metadata)) {
    if (stableStringify(target[key]) !== stableStringify(value)) {
      target[key] = cloneJson(value)
      changed = true
    }
  }
  return changed
}

export function setNotebookMetadata(notebook: Notebook, metadata: JsonObject): void {
  if (mergeMetadata(notebook.metadata, metadata)) notebook.changed = true
}

export function setCellMetadata(notebook: Notebook, index: number, metadata: JsonObject): void {
  const cell = notebook.cells[findCellIndex(notebook, index)]!
  const current = isObject(cell.json.metadata) ? cell.json.metadata : {}
  if (mergeMetadata(current as JsonObject, metadata)) {
    cell.json.metadata = current
    notebook.changed = true
  }
}

// ── A run's outputs, merged back ────────────────────────────────────────

/**
 * Merges a finished run's outputs and execution counts into the notebook **by cell id** (design §9.3). Every run cell
 * must still exist, still be a code cell, and still have the source it had at run start; otherwise nothing is written
 * and the call answers `NOTEBOOK_CHANGED`, naming the run's files. The caller writes the file (package D), which is
 * where the host's `edit` ask belongs.
 */
export function mergeRunOutputs(notebook: Notebook, cells: readonly RunCell[], outputDir: string): void {
  // Check every run cell first, so a failure leaves the model exactly as it was.
  const targets = cells.map((run) => {
    const index = notebook.cells.findIndex((cell) => cell.id === run.id)
    const cell = index === -1 ? undefined : notebook.cells[index]
    if (!cell || cellType(cell) !== "code" || cellSource(cell) !== run.source) {
      throw new ColabError("NOTEBOOK_CHANGED", "The notebook changed while the run was going, so its outputs were not written into it.", {
        next: `The outputs are kept in ${outputDir}; read the notebook again with colab_notebook, then run again.`,
      })
    }
    return { cell, run }
  })
  for (const { cell, run } of targets) {
    cell.json.outputs = run.outputs.map((output) => cloneJson(output) as JsonObject)
    cell.json.execution_count = run.executionCount
    notebook.changed = true
  }
}
