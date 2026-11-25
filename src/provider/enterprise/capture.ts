/**
 * An Enterprise job's result notebook, captured as the same cell shape a consumer run returns (design §9.2, §9.3):
 * streams cut head 40 + tail 40 lines and 8 KiB per cell, `text/plain` results up to 2 KiB, the last 20 traceback lines,
 * and every richer output saved under `<workDir>/runs/<runId>/<cellId>-<n>.<ext>` with an `outputs.jsonl` of nbformat
 * outputs, so an agent can open a plot with `read` or hand a CSV to charts by path.
 *
 * Notebook text is untrusted data: it never reaches a `message` or `next`, and a cell's fields are cut here.
 */
import { join } from "node:path"
import type * as z from "zod"
import type { Options } from "../../options.js"
import type { CellResult, RichOutput } from "../../domain/contract.js"
import { cut } from "../../redact.js"
import type { Notebook, NotebookCell } from "./notebook.js"
import { projectPath, resolveLocal, writeOnce } from "./paths.js"

type CellView = z.output<typeof CellResult>
type RichView = z.output<typeof RichOutput>

export interface Capture {
  readonly cells: readonly CellView[]
  readonly files: readonly string[]
  readonly truncated: boolean
}

const STREAM_LINES = 40
const STREAM_BYTES = 8 * 1024
const RESULT_BYTES = 2 * 1024
const TRACEBACK_LINES = 20

const asText = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.filter((part) => typeof part === "string").join("") : "")

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined)

/** Head 40 + tail 40 lines, then a byte cap; the cut is named, not silent. */
export function clipStream(text: string, options: { readonly lines?: number; readonly bytes?: number } = {}): { readonly text: string; readonly truncated: boolean } {
  const limitLines = options.lines ?? STREAM_LINES
  const limitBytes = options.bytes ?? STREAM_BYTES
  const lines = text.split("\n")
  let clipped = text
  let truncated = false
  if (lines.length > limitLines * 2) {
    clipped = [...lines.slice(0, limitLines), `…[cut ${lines.length - limitLines * 2} lines]`, ...lines.slice(-limitLines)].join("\n")
    truncated = true
  }
  if (Buffer.byteLength(clipped) > limitBytes) {
    const head = Buffer.from(clipped).subarray(0, limitBytes).toString("utf8")
    clipped = `${head}\n…[cut ${Buffer.byteLength(clipped) - limitBytes} bytes]`
    truncated = true
  }
  return { text: clipped, truncated }
}

/** `image/png` → `png`, and the other rich types nbformat carries (design §9.3's list). */
const extension: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "text/html": "html",
  "application/json": "json",
  "text/csv": "csv",
  "text/markdown": "md",
  "text/plain": "txt",
}

function outputBytes(mime: string, value: unknown): Uint8Array | undefined {
  if (mime.startsWith("image/") && mime !== "image/svg+xml") {
    if (typeof value !== "string") return undefined
    try {
      return new Uint8Array(Buffer.from(value, "base64"))
    } catch {
      return undefined
    }
  }
  if (typeof value === "string" || Array.isArray(value)) return new Uint8Array(Buffer.from(asText(value), "utf8"))
  return undefined
}

/** One cell's outputs → streams, a result, an error and rich files. */
function cellResult(cell: NotebookCell, input: { readonly runDir: string; readonly directory: string; readonly maxOutputBytes: number; readonly full: boolean }): { readonly result: CellView; readonly files: string[]; readonly truncated: boolean } {
  const stdout: string[] = []
  const stderr: string[] = []
  const rich: RichView[] = []
  const files: string[] = []
  let result: string | undefined
  let error: CellView["error"] | undefined
  let truncated = false
  let richIndex = 0
  const stream = (text: string, name: unknown) => {
    const clip = clipStream(text, input.full ? { bytes: STREAM_BYTES * 8 } : {})
    truncated = truncated || clip.truncated
    if (name === "stderr") stderr.push(clip.text)
    else stdout.push(clip.text)
  }
  for (const output of cell.outputs) {
    const type = output.output_type
    if (type === "stream") {
      stream(asText(output.text), output.name)
      continue
    }
    if (type === "error") {
      const traceback = Array.isArray(output.traceback) ? output.traceback.filter((line) => typeof line === "string").slice(-TRACEBACK_LINES) : []
      error = { ename: typeof output.ename === "string" ? cut(output.ename, 200) : "Error", evalue: typeof output.evalue === "string" ? cut(output.evalue, 500) : "", traceback: traceback.map((line) => cut(line, 500)) }
      continue
    }
    if (type !== "execute_result" && type !== "display_data" && type !== "update_display_data") continue
    const data = record(output.data)
    if (!data) continue
    const plain = data["text/plain"]
    if (plain !== undefined) {
      const text = asText(plain)
      result = cut(text, RESULT_BYTES)
      if (text.length > RESULT_BYTES) truncated = true
    }
    for (const [mime, value] of Object.entries(data)) {
      if (mime === "text/plain" && Object.keys(data).length === 1) continue
      const bytes = outputBytes(mime, value)
      const ext = extension[mime]
      if (!bytes || !ext) continue
      if (bytes.length > input.maxOutputBytes) {
        truncated = true
        continue
      }
      const name = `${cell.id.replace(/[^A-Za-z0-9_-]/g, "_")}-${richIndex}.${ext}`
      richIndex += 1
      const target = join(input.runDir, name)
      writeOnce(target, bytes)
      rich.push({ mime, path: projectPath(input.directory, target), bytes: bytes.length })
      files.push(projectPath(input.directory, target))
    }
  }
  const state: CellView["state"] = error ? "error" : cell.type === "code" && cell.executionCount === null && cell.outputs.length === 0 ? "skipped" : "ok"
  return {
    result: {
      id: cell.id,
      state,
      executionCount: cell.executionCount,
      ms: 0,
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      ...(result !== undefined ? { result } : {}),
      ...(error !== undefined ? { error } : {}),
      rich,
    },
    files,
    truncated,
  }
}

/**
 * Save the notebook and its outputs under `<workDir>/runs/<runId>/` and return the cells. Nothing existing is replaced:
 * a second capture reads back what the first wrote.
 */
export function captureNotebook(notebook: Notebook, bytes: Uint8Array, input: { readonly options: Options; readonly directory: string; readonly runId: string; readonly full?: boolean }): Capture {
  const runDir = resolveLocal(input.directory, join(input.options.workDir, "runs", input.runId), input.options.allowedRoots)
  const notebookFile = join(runDir, "output.ipynb")
  writeOnce(notebookFile, bytes)
  const lines = notebook.cells.flatMap((cell) => cell.outputs.map((output) => JSON.stringify(output)))
  const outputsFile = join(runDir, "outputs.jsonl")
  writeOnce(outputsFile, new Uint8Array(Buffer.from(lines.map((line) => `${line}\n`).join(""), "utf8")))
  const files = [projectPath(input.directory, notebookFile), projectPath(input.directory, outputsFile)]
  let truncated = false
  const cells = notebook.cells.map((cell) => {
    const captured = cellResult(cell, { runDir, directory: input.directory, maxOutputBytes: input.options.maxOutputBytesPerCell, full: input.full ?? false })
    files.push(...captured.files)
    truncated = truncated || captured.truncated
    return captured.result
  })
  return { cells, files, truncated }
}
