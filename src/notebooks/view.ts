/**
 * The structured view of a notebook for `colab_notebook` (design §6): each selected cell as
 * `{ id, index, type, source, outputs: [{ type, mime, bytes, preview }], executionCount }`. Sources are cut to 2,000
 * characters with a visible marker and secret-screened; output previews are at most 300 characters. ANSI escapes and
 * control characters are removed or escaped first (design §7.3), so a cell's colour codes cannot act on a terminal and
 * its text cannot reorder a row.
 */
import { cellExecutionCount, cellOutputs, cellSource, cellType, type Notebook, type NotebookCell } from "./model.js"
import { screenSecrets } from "./secret.js"

export interface OutputPreviewView {
  readonly type: string
  readonly mime?: string
  readonly bytes: number
  readonly preview?: string
}

export interface CellView {
  readonly id: string
  readonly index: number
  readonly type: "code" | "markdown" | "raw"
  readonly source: string
  readonly outputs: OutputPreviewView[]
  readonly executionCount: number | null
}

export type OutputsMode = "summary" | "none" | "full"

const SOURCE_LIMIT = 2000
const PREVIEW_LIMIT = 300
/** `summary` shows the first few outputs per cell; `full` shows every mime of every output. */
const SUMMARY_OUTPUTS = 5

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/** Removes ANSI escapes and bidi marks, and escapes other C0/C1 controls; newlines and tabs stay. */
export function sanitizeText(text: string): string {
  return text
    .replace(ANSI, "")
    .replace(BIDI, "")
    .replace(CONTROLS, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)
}

/** At most `limit` characters, ending in the marker, cut between whole characters. */
export function cutWithMarker(text: string, limit: number, marker = "…[cut]"): string {
  const characters = Array.from(text)
  if (characters.length <= limit) return text
  const room = Math.max(1, limit - marker.length - 1)
  return `${characters.slice(0, room).join("").trimEnd()} ${marker}`
}

const collapsed = (text: string) => text.replace(/\s+/g, " ").trim()

/** Text as a one-line preview: sanitized, screened and collapsed, at most 300 characters. */
function previewOf(text: string): string {
  return cutWithMarker(collapsed(screenSecrets(sanitizeText(text)).text), PREVIEW_LIMIT, "…")
}

const jsonMime = (mime: string) => mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"))
/** The mimes whose value is text the preview can show; nbformat splits exactly these into lines. */
const textMime = (mime: string) => mime.startsWith("text/") || mime === "application/javascript" || mime === "image/svg+xml"

/** A base64 value's decoded byte length, without decoding it. */
function base64Bytes(value: string): number {
  const clean = value.replace(/\s+/g, "")
  if (clean.length === 0) return 0
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

function textOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.every((line) => typeof line === "string")) return value.join("")
  return undefined
}

function mimeEntries(output: Record<string, unknown>): OutputPreviewView[] {
  const type = typeof output.output_type === "string" ? output.output_type : "output"
  if (output.output_type === "stream") {
    const text = textOf(output.text) ?? ""
    return [{ type, mime: "text/plain", bytes: Buffer.byteLength(text), preview: previewOf(text) }]
  }
  if (output.output_type === "error") {
    const name = typeof output.ename === "string" ? output.ename : ""
    const value = typeof output.evalue === "string" ? output.evalue : ""
    const text = name || value ? `${name}: ${value}` : ""
    return [{ type, mime: "text/plain", bytes: Buffer.byteLength(text), preview: previewOf(text) }]
  }
  const data = output.data
  if (typeof data !== "object" || data === null || Array.isArray(data)) return [{ type, bytes: 0 }]
  const entries: OutputPreviewView[] = []
  for (const [mime, value] of Object.entries(data)) {
    const text = textOf(value)
    if (text !== undefined && (textMime(mime) || jsonMime(mime))) {
      entries.push({ type, mime, bytes: Buffer.byteLength(text), preview: previewOf(text) })
    } else if (text !== undefined) {
      entries.push({ type, mime, bytes: mime.startsWith("image/") && /^[A-Za-z0-9+/=\s]+$/.test(text) ? base64Bytes(text) : Buffer.byteLength(text) })
    } else {
      entries.push({ type, mime, bytes: Buffer.byteLength(JSON.stringify(value) ?? "") })
    }
  }
  return entries
}

/** One cell's outputs, in the requested mode. */
export function outputViews(cell: NotebookCell, mode: OutputsMode): OutputPreviewView[] {
  if (mode === "none" || cellType(cell) !== "code") return []
  const outputs = cellOutputs(cell) as unknown as readonly Record<string, unknown>[]
  const selected = mode === "summary" ? outputs.slice(0, SUMMARY_OUTPUTS) : outputs
  return selected.flatMap((output) => mimeEntries(output))
}

/** Builds the view for the cells a selector named. */
export function cellViews(notebook: Notebook, indices: readonly number[], mode: OutputsMode): CellView[] {
  return indices.map((index) => {
    const cell = notebook.cells[index]!
    const source = cutWithMarker(screenSecrets(sanitizeText(cellSource(cell))).text, SOURCE_LIMIT)
    return { id: cell.id, index, type: cellType(cell), source, outputs: outputViews(cell, mode), executionCount: cellExecutionCount(cell) }
  })
}

/** Whether any selected cell's source or shown output was secret-shaped (for warning `SECRET_WITHHELD`). */
export function secretsInView(notebook: Notebook, indices: readonly number[], mode: OutputsMode): boolean {
  for (const index of indices) {
    const cell = notebook.cells[index]!
    if (screenSecrets(cellSource(cell)).matches > 0) return true
    if (mode === "none" || cellType(cell) !== "code") continue
    const outputs = cellOutputs(cell) as unknown as readonly Record<string, unknown>[]
    const selected = mode === "summary" ? outputs.slice(0, SUMMARY_OUTPUTS) : outputs
    for (const output of selected) {
      const text = output.output_type === "stream" ? textOf(output.text) : output.output_type === "error" ? `${String(output.ename ?? "")}: ${String(output.evalue ?? "")}` : undefined
      if (text !== undefined && screenSecrets(text).matches > 0) return true
      const data = output.data
      if (typeof data === "object" && data !== null && !Array.isArray(data)) {
        for (const [mime, value] of Object.entries(data)) {
          // Only the mimes whose text is shown are screened: a base64 image is not a secret and has no preview.
          if (!textMime(mime) && !jsonMime(mime)) continue
          const valueText = textOf(value)
          if (valueText !== undefined && screenSecrets(valueText).matches > 0) return true
        }
      }
    }
  }
  return false
}
