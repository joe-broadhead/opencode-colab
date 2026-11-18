/**
 * Capture: one cell's iopub stream turned into what a result shows and what nbformat stores (design §9.2, §9.3).
 *
 * The shapes are Jupyter's messaging protocol (design §18 [19]: https://jupyter-client.readthedocs.io/en/stable/messaging.html
 * — `stream`, `display_data`, `update_display_data`, `execute_result`, `error`, `clear_output`, `status`) and nbformat
 * 4's code-cell outputs (https://nbformat.readthedocs.io/en/latest/format_description.html#code-cell-outputs). The one
 * message that is not Jupyter's is `colab_request`, colabtools' UI request (design §18 [9]; colab-vscode's decline is
 * [4]): package B answers it at once, and capture records that the cell reached a Colab UI API so the run reports
 * COLAB_UI_API.
 *
 * Inline caps: per cell, streams are cut to their first 40 and last 40 lines and to 8 KiB together, an execute result
 * to 2 KiB, and a cell's whole inline output to `maxOutputBytesPerCell`; a larger stream is written to a file and the
 * cell says so (design §9.3). Rich outputs are never inline: each becomes a file under the run's folder, and the result
 * carries its path and size only. A secret-shaped value is withheld from everything inline (`screenSecrets`), while the
 * saved file keeps the bytes, as design §7.5 says.
 */
import { readFile, unlink } from "node:fs/promises"
import { join } from "node:path"
import type { IopubMessage } from "../ports.js"
import { screenSecrets } from "../redact.js"
import { writeAtomic } from "./paths.js"
import { safeText, sha256, shownPath } from "./support.js"

/** 8 KiB of streams and 2 KiB of result per cell (design §9.2). */
const STREAM_BYTES = 8 * 1024
const RESULT_BYTES = 2 * 1024
const STREAM_LINES = 40
const TRACEBACK_LINES = 20

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
const stripAnsi = (text: string) => text.replace(ANSI, "")

/** Extension and whether Jupyter carries the mime as base64. */
const RICH: Readonly<Record<string, { readonly ext: string; readonly base64: boolean }>> = {
  "image/png": { ext: "png", base64: true },
  "image/jpeg": { ext: "jpg", base64: true },
  "image/svg+xml": { ext: "svg", base64: false },
  "text/html": { ext: "html", base64: false },
  "application/json": { ext: "json", base64: false },
  "text/markdown": { ext: "md", base64: false },
  "text/latex": { ext: "tex", base64: false },
}

type MimeBundle = Readonly<Record<string, unknown>>
type Json = Record<string, unknown>

/** A multiline mime value is a string or an array of strings in Jupyter and nbformat alike. */
const textOf = (value: unknown): string => (Array.isArray(value) ? value.map((part) => String(part)).join("") : typeof value === "string" ? value : (JSON.stringify(value) ?? ""))

/** Jupyter's rich data: strings as sent, JSON mimes as an object (which nbformat stores as an object). */
function bundleOf(value: unknown): MimeBundle {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as MimeBundle) : {}
}

/** A stream with carriage returns shows its final state inline (a progress bar must not be 5,000 lines). */
export function carriageReturns(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line
      const parts = line.split("\r")
      return parts.filter((part) => part !== "").at(-1) ?? ""
    })
    .join("\n")
}

/** At most `limit` UTF-8 bytes, cut on a character boundary, ending with a marker. */
export function cutBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  let out = ""
  let bytes = 0
  for (const character of text) {
    const size = Buffer.byteLength(character)
    if (bytes + size > limit - 32) break
    out += character
    bytes += size
  }
  return `${out}…[${Buffer.byteLength(text) - bytes} bytes cut]`
}

/** Head 40 + tail 40 lines, then at most `limit` bytes, with a marker naming what was cut. */
export function cutStream(text: string, limit = STREAM_BYTES): string {
  const lines = carriageReturns(text).split("\n")
  const kept = lines.length > STREAM_LINES * 2 + 1 ? [...lines.slice(0, STREAM_LINES), `…[cut ${lines.length - STREAM_LINES * 2} lines]`, ...lines.slice(-STREAM_LINES)].join("\n") : lines.join("\n")
  return cutBytes(kept, limit)
}

export interface RichFile {
  readonly mime: string
  readonly path: string
  readonly bytes: number
  readonly width?: number
  readonly height?: number
}

export interface CapturedError {
  readonly ename: string
  readonly evalue: string
  readonly traceback: readonly string[]
}

export interface CapturedCell {
  readonly id: string
  readonly source: string
  readonly state: "ok" | "error" | "skipped" | "running"
  readonly executionCount: number | null
  readonly ms: number
  readonly stdout: string
  readonly stderr: string
  readonly result?: string
  /** The cell's whole text, capped at `maxCellBytes` (a larger one is in the overflow file the note names). */
  readonly fullStdout: string
  readonly fullStderr: string
  readonly fullResult?: string
  readonly error?: CapturedError
  readonly rich: readonly RichFile[]
  /** nbformat 4 code-cell outputs, exactly as the file and `outputs.jsonl` carry them. */
  readonly outputs: readonly Json[]
  /** Set when the cell reached a Colab UI API (`colab_request`); the run reports COLAB_UI_API. */
  readonly uiApi?: string
}

export interface CaptureOptions {
  readonly cellId: string
  readonly source: string
  /** The run's folder, absolute. */
  readonly dir: string
  /** The project folder, so a result shows a relative path. */
  readonly directory: string
  readonly maxCellBytes: number
  readonly maxFileBytes: number
}

interface Display {
  /** The file index the first `display_data` used. */
  readonly index: number
  readonly files: string[]
}

/** One cell's capture: `consume` for every iopub message of its request, then `finish`. */
export function capture(options: CaptureOptions) {
  const started = Date.now()
  let executionCount: number | null = null
  let state: CapturedCell["state"] = "running"
  let stdout = ""
  let stderr = ""
  let result: string | undefined
  let error: CapturedError | undefined
  let uiApi: string | undefined
  let outputs: Json[] = []
  const rich: RichFile[] = []
  const displays = new Map<string, Display>()
  let pendingClear = false
  let counter = 0
  const notes: string[] = []

  const clear = async () => {
    outputs = []
    stdout = ""
    stderr = ""
    result = undefined
    error = undefined
    rich.length = 0
    for (const display of displays.values()) for (const file of display.files) await unlink(file).catch(() => undefined)
    displays.clear()
  }

  /** Writes one mime value to the run folder; `index` is the output's number, so a display update rewrites the file. */
  const save = async (mime: string, value: unknown, metadata: MimeBundle | undefined, index: number): Promise<{ readonly file: string; readonly saved: RichFile } | undefined> => {
    const format = RICH[mime]
    if (!format) return undefined
    if (format.base64 && typeof value !== "string") return undefined
    const bytes = format.base64 ? Buffer.from(String(value), "base64") : Buffer.from(textOf(value), "utf8")
    if (bytes.byteLength > options.maxFileBytes) {
      notes.push(`…[${mime} output of ${bytes.byteLength} bytes was not saved: over maxOutputBytesPerCell]`)
      return undefined
    }
    const file = join(options.dir, `${options.cellId}-${index}.${format.ext}`)
    await writeAtomic(file, new Uint8Array(bytes))
    const size = metadata?.[mime] as { width?: unknown; height?: unknown } | undefined
    const width = typeof size?.width === "number" ? size.width : undefined
    const height = typeof size?.height === "number" ? size.height : undefined
    return { file, saved: { mime, path: shownPath(file, options.directory), bytes: bytes.byteLength, ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) } }
  }

  const addRich = async (display: Display | undefined, data: MimeBundle, metadata: MimeBundle): Promise<void> => {
    for (const [mime, value] of Object.entries(data)) {
      if (!RICH[mime]) continue
      const index = display?.index ?? counter
      const written = await save(mime, value, metadata, index)
      if (!written) continue
      const existing = rich.findIndex((entry) => entry.path === written.saved.path)
      if (existing === -1) rich.push(written.saved)
      else rich[existing] = written.saved
      display?.files.push(written.file)
    }
  }

  const consume = async (message: IopubMessage): Promise<void> => {
    if (pendingClear && message.msgType !== "clear_output") {
      await clear()
      pendingClear = false
    }
    const content = message.content as Json
    switch (message.msgType) {
      case "status": {
        if (content.execution_state === "idle") state = state === "running" ? (error ? "error" : "ok") : state
        return
      }
      case "execute_input": {
        if (typeof content.execution_count === "number") executionCount = content.execution_count
        return
      }
      case "stream": {
        const name = content.name === "stderr" ? "stderr" : "stdout"
        const text = textOf(content.text)
        if (name === "stderr") stderr += text
        else stdout += text
        outputs.push({ output_type: "stream", name, text })
        return
      }
      case "display_data":
      case "update_display_data": {
        const data = bundleOf(content.data)
        const metadata = bundleOf(content.metadata)
        const displayId = (content.transient as { display_id?: unknown } | undefined)?.display_id
        if (message.msgType === "update_display_data" && typeof displayId === "string") {
          const existing = outputs.findIndex((output) => (output.transient as { display_id?: string } | undefined)?.display_id === displayId)
          const display = displays.get(displayId)
          if (existing === -1 || !display) return
          outputs[existing] = { output_type: "display_data", data, metadata, transient: { display_id: displayId } }
          await addRich(display, data, metadata)
          return
        }
        counter += 1
        const display = typeof displayId === "string" ? { index: counter, files: [] } : undefined
        if (display && typeof displayId === "string") displays.set(displayId, display)
        outputs.push({ output_type: "display_data", data, metadata, ...(typeof displayId === "string" ? { transient: { display_id: displayId } } : {}) })
        await addRich(display, data, metadata)
        return
      }
      case "execute_result": {
        if (typeof content.execution_count === "number") executionCount = content.execution_count
        const data = bundleOf(content.data)
        const metadata = bundleOf(content.metadata)
        counter += 1
        outputs.push({ output_type: "execute_result", data, metadata, execution_count: executionCount })
        if (data["text/plain"] !== undefined) result = textOf(data["text/plain"])
        await addRich(undefined, data, metadata)
        return
      }
      case "error": {
        const raw = Array.isArray(content.traceback) ? content.traceback.map((line) => stripAnsi(textOf(line))) : []
        error = { ename: safeText(textOf(content.ename)), evalue: safeText(textOf(content.evalue)), traceback: raw.slice(-TRACEBACK_LINES) }
        outputs.push({ output_type: "error", ename: error.ename, evalue: error.evalue, traceback: content.traceback ?? [] })
        state = "error"
        return
      }
      case "clear_output": {
        if (content.wait === true) pendingClear = true
        else await clear()
        return
      }
      case "colab_request": {
        uiApi ??= safeText(textOf(content.request_type ?? content.type ?? "colab_request"))
        return
      }
      default:
        // `comm_open`, `comm_msg` and anything a newer kernel sends: not an output.
        return
    }
  }

  /** The cell's final capture, with every inline cap and the secret screen applied. */
  async function finish(final: CapturedCell["state"]): Promise<CapturedCell> {
    state = state === "running" ? final : state
    let shownOut = cutStream(stdout)
    let shownErr = cutStream(stderr)
    let resultText = result === undefined ? undefined : cutBytes(result, RESULT_BYTES)
    const bytes = Buffer.byteLength(shownOut) + Buffer.byteLength(shownErr) + Buffer.byteLength(resultText ?? "")
    if (bytes > options.maxCellBytes) {
      const file = join(options.dir, `${options.cellId}-output-1.txt`)
      await writeAtomic(file, Buffer.from(`${stdout}${stderr}`, "utf8"))
      const note = `…[output over ${options.maxCellBytes} bytes: the full text is in ${shownPath(file, options.directory)}]`
      shownOut = cutBytes(shownOut, Math.max(256, Math.floor(options.maxCellBytes / 2)))
      shownErr = cutBytes(shownErr, Math.max(128, Math.floor(options.maxCellBytes / 4)))
      resultText = resultText === undefined ? undefined : cutBytes(resultText, Math.max(128, Math.floor(options.maxCellBytes / 4)))
      notes.push(note)
    }
    return {
      id: options.cellId,
      source: options.source,
      state,
      executionCount,
      ms: Date.now() - started,
      stdout: screened([shownOut, ...notes].filter(Boolean).join("\n")),
      stderr: screened(shownErr),
      ...(resultText !== undefined ? { result: screened(resultText) } : {}),
      fullStdout: screened(cutBytes(stdout, options.maxCellBytes)),
      fullStderr: screened(cutBytes(stderr, options.maxCellBytes)),
      ...(result !== undefined ? { fullResult: screened(cutBytes(result, options.maxCellBytes)) } : {}),
      ...(error ? { error: { ...error, evalue: screened(error.evalue) } } : {}),
      rich,
      outputs,
      ...(uiApi !== undefined ? { uiApi } : {}),
    }
  }

  return { consume, finish, started }
}

/** Everything inline passes the one secret screen (design §7.5); the saved files keep the bytes. */
export const screened = (text: string) => screenSecrets(text).text

/** A sha256 over one cell's outputs, for `outputs.jsonl` integrity and tests. */
export const outputsHash = (outputs: readonly Json[]) => sha256(JSON.stringify(outputs))

/** Reads back the lines `outputs.jsonl` holds, so a later process (or `colab_execution`) sees a finished run. */
export async function readOutputs(file: string): Promise<Json[]> {
  const text = await readFile(file, "utf8").catch(() => "")
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Json]
      } catch {
        return []
      }
    })
}

/** A cell capture from `outputs.jsonl`, for a run this process no longer holds. */
export function cellFromLine(line: Json): CapturedCell | undefined {
  if (typeof line.cellId !== "string") return undefined
  const value = line.cell as Partial<CapturedCell> | undefined
  if (!value) return undefined
  return {
    id: line.cellId,
    source: typeof value.source === "string" ? value.source : "",
    state: (value.state as CapturedCell["state"]) ?? "ok",
    executionCount: typeof value.executionCount === "number" ? value.executionCount : null,
    ms: typeof value.ms === "number" ? value.ms : 0,
    stdout: typeof value.stdout === "string" ? value.stdout : "",
    stderr: typeof value.stderr === "string" ? value.stderr : "",
    fullStdout: typeof value.fullStdout === "string" ? value.fullStdout : typeof value.stdout === "string" ? value.stdout : "",
    fullStderr: typeof value.fullStderr === "string" ? value.fullStderr : typeof value.stderr === "string" ? value.stderr : "",
    ...(typeof value.result === "string" ? { result: value.result } : {}),
    ...(typeof value.fullResult === "string" ? { fullResult: value.fullResult } : {}),
    ...(value.error ? { error: value.error } : {}),
    rich: (Array.isArray(line.rich) ? line.rich : []) as RichFile[],
    outputs: (Array.isArray(line.outputs) ? line.outputs : []) as Json[],
    ...(typeof value.uiApi === "string" ? { uiApi: value.uiApi } : {}),
  }
}

/** The one line `outputs.jsonl` holds for a cell: the nbformat outputs plus what the tool result needs to rebuild it. */
export function outputsLine(cell: CapturedCell): Json {
  const { id, source, state, executionCount, ms, stdout, stderr, result, fullStdout, fullStderr, fullResult, error, rich, outputs, uiApi } = cell
  return {
    cellId: id,
    outputs,
    rich,
    cell: {
      source,
      state,
      executionCount,
      ms,
      stdout,
      stderr,
      ...(result !== undefined ? { result } : {}),
      fullStdout,
      fullStderr,
      ...(fullResult !== undefined ? { fullResult } : {}),
      ...(error ? { error } : {}),
      ...(uiApi !== undefined ? { uiApi } : {}),
    },
  }
}
