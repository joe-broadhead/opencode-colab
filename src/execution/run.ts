/**
 * `colab_run` (design §6, §7.3, §7.4, §9.1): code or notebook cells on a consumer runtime **the plugin created**.
 *
 * The order is the guarantee's order. The runtime must be a ready, untainted ledger record of ours with a calibration;
 * the pre-run probe must pass before any agent code is sent; every `execute_request` carries `allow_stdin: false`;
 * the run starts a kernel-side watchdog before the first cell and cancels it after the last, so it is bounded even if
 * OpenCode exits; the post-run probe runs under the same call's one `colab.run` assertion, and a finding taints the
 * runtime for good.
 *
 * A run outlives its tool call (design §9.4): collection continues in this process while `colab_run` answers
 * `state: "running"`, and the tool's own Stop interrupts the kernel. The kernel session is one per (runtime, notebook)
 * or per `session`, so variables survive between runs, and one session runs one run at a time (KERNEL_BUSY).
 *
 * Write-back (design §9.3) goes through `deps.notebooks.mergeRun` under package C's per-path lock, after the host's
 * `edit`; a notebook that moved during the run answers NOTEBOOK_CHANGED with nothing written, and the outputs stay under
 * `.colab/runs/<runId>` — the result names that folder, so it says what landed.
 */
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import type { InputOf } from "../domain/contract.js"
import { ColabError, type ErrorCode } from "../domain/errors.js"
import type { ProbeVerdict, RunRecord, RuntimeRecord } from "../ports.js"
import type { HandlerContext, ToolHandler } from "../tools/types.js"
import { capture, outputsLine, screened, type CapturedCell } from "./capture.js"
import { resolveLocal, writeAtomic } from "./paths.js"
import { beginRun, runOnSession, runsOn } from "./runs.js"
import { calibrated, cut, oursById, PROBE_SESSION_SUFFIX, safeText, sessionName, sha256, shownPath, ulid } from "./support.js"

/** The longest a call waits for output (design §9.1: `B`; 4 minutes until the host measurement lands). */
export const WAIT_SECONDS = 240
/** The default kernel-side bound (design §8.2: 30 minutes). */
export const DEFAULT_TIMEOUT_SECONDS = 1800
/** Runs this process collects on one runtime at a time (design §9.4). */
export const RUNS_PER_RUNTIME = 4

type Input = InputOf<"run">

export interface SourceCell {
  readonly id: string
  readonly type: "code" | "markdown" | "raw"
  readonly source: string
}

const indexOf = (cells: readonly SourceCell[], reference: string | number): number => {
  if (typeof reference === "number") return reference >= 0 && reference < cells.length ? reference : -1
  return cells.findIndex((cell) => cell.id === reference)
}

/**
 * The cells a run names: `all` is every code cell; an array mixes ids and indexes; `{ from, to }` is inclusive. A named
 * markdown or raw cell is refused (INPUT_INVALID) rather than silently skipped, because the person asked for it.
 */
export function selectCells(cells: readonly SourceCell[], selector: Input["cells"] | undefined): { readonly cell: SourceCell; readonly index: number }[] {
  if (selector === undefined || selector === "all") {
    const code = cells.flatMap((cell, index) => (cell.type === "code" ? [{ cell, index }] : []))
    if (code.length === 0) throw new ColabError("INPUT_INVALID", "The notebook has no code cells to run.")
    return code
  }
  const named = (reference: string | number, what: string) => {
    const index = indexOf(cells, reference)
    if (index === -1) throw new ColabError("NOT_FOUND", `The notebook has no cell ${what}.`)
    const cell = cells[index]!
    if (cell.type !== "code") throw new ColabError("INPUT_INVALID", `Cell ${what} is a ${cell.type} cell; only code cells run.`)
    return { cell, index }
  }
  let picked: { cell: SourceCell; index: number }[]
  if (Array.isArray(selector)) picked = selector.map((reference) => named(reference, typeof reference === "number" ? `at index ${reference}` : reference))
  else {
    const from = indexOf(cells, selector.from)
    const to = indexOf(cells, selector.to)
    if (from === -1 || to === -1) throw new ColabError("NOT_FOUND", "The range names a cell the notebook does not have.")
    if (from > to) throw new ColabError("INPUT_INVALID", "The range's from cell comes after its to cell.")
    picked = cells.flatMap((cell, index) => (index >= from && index <= to && cell.type === "code" ? [{ cell, index }] : []))
  }
  const seen = new Set<string>()
  const unique = picked.filter((entry) => (seen.has(entry.cell.id) ? false : (seen.add(entry.cell.id), true)))
  if (unique.length === 0) throw new ColabError("INPUT_INVALID", "The run names no code cell.")
  return unique
}

/** Code the tool was given, as the one cell a run has; its id is `code`, and it never writes back. */
const codeCells = (code: string): { cell: SourceCell; index: number }[] => [{ cell: { id: "code", type: "code", source: code }, index: 0 }]

/** Shell, package-install and network lines: what the person's ask shows before code runs (design §7.3). */
export function flagged(line: string): readonly ("shell" | "install" | "network")[] {
  const text = line.trim()
  const flags: ("shell" | "install" | "network")[] = []
  if (/^!/.test(text) || /^%%(?:bash|sh|shell|script)\b/.test(text) || /\bsubprocess\b/.test(text) || /\bos\.system\b/.test(text)) flags.push("shell")
  if (/^(?:%pip|%conda|!pip|!conda)\b/.test(text) || /\bpip\s+install\b/.test(text) || /\bconda\s+install\b/.test(text)) flags.push("install")
  if (/\b(?:requests|urllib|httpx|http\.client|socket|curl|wget)\b/.test(text) || /\bfrom\s+(?:requests|urllib|http)\b/.test(text)) flags.push("network")
  return flags
}

/** One cell's preview: its first 6 lines, the source's sha256 and the flagged lines; secret-shaped text is withheld. */
export function previewOf(cell: SourceCell): Readonly<Record<string, unknown>> {
  const lines = cell.source.split("\n").slice(0, 6).map((line) => screened(cut(line, 240)))
  const flags = cell.source
    .split("\n")
    .flatMap((line, index) => flagged(line).map((flag) => ({ line: index + 1, flag })))
  return { id: cell.id, lines, sha256: `sha256:${sha256(cell.source)}`, ...(flags.length ? { flags } : {}) }
}

/** The ask's metadata: computed before the one `colab.run` assert, never holding a token or the runtime URL. */
async function metadata(input: Input, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>> {
  const selected =
    input.code !== undefined ? codeCells(input.code) : selectCells((await ctx.deps.notebooks.read(input.notebook!.path, ctx.call.signal)).cells, input.cells)
  const limit = 20
  return {
    cells: selected.slice(0, limit).map(({ cell }) => previewOf(cell)),
    ...(selected.length > limit ? { moreCells: selected.length - limit } : {}),
    timeoutSec: input.timeoutSec ?? DEFAULT_TIMEOUT_SECONDS,
  }
}

const specLabel = (spec: RuntimeRecord["spec"]) => (spec.variant === "VARIANT_CPU" ? `CPU/${spec.shape.replace("SHAPE_", "").toLowerCase()}` : `${spec.accelerator}/${spec.shape.replace("SHAPE_", "").toLowerCase()}`)

/** The elapsed time in the ledger's wording: "42 s", "2 min 5 s". */
const elapsed = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`)

function summaryOf(input: Input, cells: readonly CapturedCell[], spec: string, startedAt: number, endedAt: number): string {
  const what = input.notebook ? `${cells.length} cell${cells.length === 1 ? "" : "s"} of the notebook` : "code"
  const failed = cells.find((cell) => cell.state === "error")
  const outcome = failed ? `failed at a cell (${safeText(failed.error?.ename ?? "error")})` : "finished"
  return `Ran ${what} on ${spec} — ${outcome}, ${elapsed(endedAt - startedAt)}`
}

/** A probe that refuses; a finding taints the record here as well as in package B (a test's fake check does not). */
async function probe(found: Awaited<ReturnType<typeof calibrated>>, ctx: HandlerContext, input: { readonly fresh: boolean }, signal: AbortSignal): Promise<ProbeVerdict> {
  const verdict = await ctx.deps.check.probe(found.target, { nonce: found.record.nonce, calibration: found.calibration, fresh: input.fresh }, signal)
  if (!verdict.ok && verdict.code !== "RUNTIME_UNVERIFIED") await ctx.deps.ledger.taint(found.record.id, { code: verdict.code, at: verdict.at })
  return verdict
}

const isAbort = (error: unknown) => error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")

/** `timeoutSec`: the caller's value, never above maxRunSeconds; the default is clamped to the option too. */
export function boundTimeout(requested: number | undefined, maxRunSeconds: number): number {
  if (requested === undefined) return Math.min(DEFAULT_TIMEOUT_SECONDS, maxRunSeconds)
  if (requested > maxRunSeconds) throw new ColabError("INPUT_INVALID", `timeoutSec ${requested} is above this plugin's maxRunSeconds (${maxRunSeconds}).`, { next: `Use ${maxRunSeconds} or less, or raise maxRunSeconds.` })
  return requested
}

/** Waits for the background collection up to `ms`, or until the call's signal aborts; false when still running. */
export async function waitForCompletion(task: Promise<unknown>, ms: number, signal: AbortSignal): Promise<boolean> {
  const settled = task.then(
    () => true,
    () => true,
  )
  if (ms <= 0) return await Promise.race([settled, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))])
  return await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve(false)
    }, ms)
    const abort = () => {
      clearTimeout(timer)
      reject(new DOMException("Aborted", "AbortError"))
    }
    signal.addEventListener("abort", abort, { once: true })
    void settled.then(() => {
      clearTimeout(timer)
      signal.removeEventListener("abort", abort)
      resolve(true)
    })
  })
}

const skippedCell = (cell: SourceCell): CapturedCell => ({ id: cell.id, source: cell.source, state: "skipped", executionCount: null, ms: 0, stdout: "", stderr: "", fullStdout: "", fullStderr: "", rich: [], outputs: [] })

const cellResult = (cell: CapturedCell) => ({
  id: cell.id,
  state: cell.state,
  executionCount: cell.executionCount,
  ms: cell.ms,
  stdout: cell.stdout,
  stderr: cell.stderr,
  ...(cell.result !== undefined ? { result: cell.result } : {}),
  ...(cell.error ? { error: { ename: cell.error.ename, evalue: cell.error.evalue, traceback: [...cell.error.traceback] } } : {}),
  rich: [...cell.rich],
})

export const run: ToolHandler<"run"> = {
  metadata,
  async run(input, ctx) {
    if (ctx.account.backend !== "colab") {
      throw new ColabError("INTERACTIVE_UNSUPPORTED", "This account is a Colab Enterprise account, and the plugin runs code only on consumer runtimes it created.", {
        next: 'Plan colab_plan({ action: "job.create", params: { notebook } }) instead.',
      })
    }
    const found = calibrated(await oursById(ctx.deps.ledger, ctx.account.alias, input.runtime))
    // One run per session and four per runtime (design §9.4); both are checked before any network call.
    const name = sessionName(found.record, { ...(input.notebook ? { notebook: input.notebook.path } : {}), ...(input.session ? { session: input.session } : {}) })
    if (name.endsWith(PROBE_SESSION_SUFFIX)) throw new ColabError("INPUT_INVALID", "The session name collides with the plugin's probe session.", { next: "Use another session name." })
    if (runOnSession(found.record.id, name)) throw new ColabError("KERNEL_BUSY", "That kernel session is already running a run in this process.")
    if (runsOn(found.record.id) >= RUNS_PER_RUNTIME) throw new ColabError("RUNTIME_BUSY", `This runtime already runs ${RUNS_PER_RUNTIME} runs in this process.`)

    const before = await probe(found, ctx, { fresh: false }, ctx.call.signal)
    if (!before.ok) {
      throw new ColabError(
        before.code,
        before.code === "RUNTIME_UNVERIFIED" ? "The runtime check before this run could not complete, so no code was sent." : "The runtime check found something on the runtime that the plugin will not run beside, so no code was sent.",
      )
    }

    // The cells are read from the notebook as it is now; their ids and sources are what write-back checks against.
    const selected = input.code !== undefined ? codeCells(input.code) : selectCells((await ctx.deps.notebooks.read(input.notebook!.path, ctx.call.signal)).cells, input.cells)
    const timeoutSec = boundTimeout(input.timeoutSec, ctx.deps.options.maxRunSeconds)
    const waitMs = Math.min(input.wait ?? 60, WAIT_SECONDS) * 1000

    const runId = ulid()
    const dir = join(ctx.deps.directory, ctx.deps.options.workDir, "runs", runId)
    const dirShown = shownPath(dir, ctx.deps.directory)
    await mkdir(dir, { recursive: true })
    const startedAtMs = ctx.deps.clock.now().getTime()
    const spec = specLabel(found.record.spec)
    const record: RunRecord = {
      runId,
      account: ctx.account.alias,
      backend: "colab",
      runtime: found.record.id,
      ...(input.notebook ? { notebook: input.notebook.path } : {}),
      cellIds: selected.map(({ cell }) => cell.id),
      spec,
      startedAt: new Date(startedAtMs).toISOString(),
      state: "running",
      outputPaths: [],
      summary: `${input.notebook ? `Running ${selected.length} cell(s) of the notebook` : "Running code"} on ${spec}`,
    }
    await ctx.deps.ledger.putRun(record)
    ctx.deps.events.publish({ type: "started", runId, account: ctx.account.alias })

    // The session handle and the run's own controller: the call's signal bounds only the tool call, never the run.
    const session = await ctx.deps.runtime.openSession(found.target, { name, path: "/content" }, ctx.call.signal)
    const handle = beginRun({ runId, account: ctx.account.alias, runtime: found.record.id, session: name, kernel: session })
    const captured: CapturedCell[] = []
    const outputPaths = new Set<string>()
    let timedOut = false
    let uiApi: string | undefined
    let failure: unknown
    let state: RunRecord["state"] = "ok"

    /** Writes the run's disk copy: the nbformat outputs of every cell captured so far, one JSON line each. */
    const checkpoint = async () => {
      const text = `${captured.map((cell) => JSON.stringify(outputsLine(cell))).join("\n")}${captured.length ? "\n" : ""}`
      await writeAtomic(join(dir, "outputs.jsonl"), Buffer.from(text, "utf8"))
    }

    const finishRecord = async (finalState: RunRecord["state"], errorCode?: ErrorCode) => {
      const endedAt = ctx.deps.clock.now().getTime()
      if (captured.length) outputPaths.add(join(dir, "outputs.jsonl"))
      await ctx.deps.ledger
        .putRun({
          ...record,
          endedAt: new Date(endedAt).toISOString(),
          state: finalState,
          outputPaths: [...outputPaths].map((path) => shownPath(path, ctx.deps.directory)),
          ...(errorCode ? { errorCode } : {}),
          summary: summaryOf(input, captured, spec, startedAtMs, endedAt),
        })
        .catch(() => undefined)
      state = finalState
      ctx.deps.events.publish({ type: "finished", runId, state })
    }

    const collect = async (): Promise<string | undefined> => {
      try {
        await session.watchdog(timeoutSec, handle.live.controller.signal)
        const timer = setTimeout(() => {
          timedOut = true
          void session.interrupt(AbortSignal.timeout(15_000)).catch(() => undefined)
        }, timeoutSec * 1000)
        try {
          for (const [position, entry] of selected.entries()) {
            handle.live.controller.signal.throwIfAborted()
            const cell = capture({
              cellId: entry.cell.id,
              source: entry.cell.source,
              dir,
              directory: ctx.deps.directory,
              maxCellBytes: ctx.deps.options.maxOutputBytesPerCell,
              maxFileBytes: ctx.deps.options.maxOutputBytesPerCell,
            })
            let sawIdle = false
            let streamError: unknown
            try {
              for await (const message of session.execute(entry.cell.source, { allowStdin: false, silent: false, storeHistory: true }, handle.live.controller.signal)) {
                await cell.consume(message)
                if (message.msgType === "status" && message.content.execution_state === "idle") sawIdle = true
              }
            } catch (error) {
              streamError = error
            }
            const result = await cell.finish(timedOut || streamError !== undefined ? "error" : "ok")
            captured.push(result)
            if (result.uiApi) uiApi ??= result.uiApi
            for (const rich of result.rich) outputPaths.add(rich.path)
            await checkpoint()
            ctx.deps.events.publish({ type: "cell", runId, cellId: result.id, state: result.state === "error" ? "error" : "ok" })
            handle.progress(captured)
            if (streamError !== undefined) {
              // A Stop ends the run as cancelled; a timed-out interrupt ends it as RUN_TIMEOUT; anything else is a transport failure.
              if (isAbort(streamError) || handle.live.controller.signal.aborted) throw new ColabError("CANCELLED")
              if (timedOut) break
              throw streamError
            }
            // A kernel that answered without going idle died mid-request (KERNEL_DIED); a timed-out interrupt is RUN_TIMEOUT.
            if (!sawIdle && !timedOut) throw new ColabError("KERNEL_DIED", "The kernel's stream ended before it went idle, which often means the kernel died.")
            if (result.state === "error" && !input.continueOnError) {
              for (const skipped of selected.slice(position + 1)) captured.push(skippedCell(skipped.cell))
              break
            }
          }
        } finally {
          clearTimeout(timer)
          // The bound that holds with OpenCode closed is cancelled once the run is over; start and cancel are paired.
          await session.watchdog(null, AbortSignal.timeout(15_000)).catch(() => undefined)
          await checkpoint().catch(() => undefined)
        }
        // The post-run probe runs before anything else can fail, so a finding always taints (design §7.4 step 3).
        const after = await probe(found, ctx, { fresh: true }, handle.live.controller.signal)
        if (timedOut) {
          throw new ColabError("RUN_TIMEOUT", `The run reached its ${timeoutSec}-second bound; the kernel was interrupted.`, {
            next: `Raise timeoutSec (up to ${ctx.deps.options.maxRunSeconds}), or use an Enterprise job. The run's files are in ${dirShown}.`,
          })
        }
        if (uiApi !== undefined) {
          throw new ColabError("COLAB_UI_API", `Cell output requested ${cut(uiApi, 80)}, a Colab UI API the plugin declines.`, {
            next: `Move files with colab_upload and colab_download; the run's files are in ${dirShown}.`,
          })
        }
        let message: string | undefined
        // Write-back is the default with a notebook; a moved notebook writes nothing and the result says where the outputs are.
        if (input.notebook && input.writeBack !== false && captured.some((cell) => cell.state !== "skipped")) {
          const target = await resolveLocal(input.notebook.path, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
          await ctx.hostAssert({ action: "edit", resources: [target.absolute], metadata: { path: shownPath(target.absolute, ctx.deps.directory), runId } })
          if (!target.insideProject) await ctx.hostAssert({ action: "external_directory", resources: [join(target.absolute, "..")], metadata: { path: target.absolute } })
          const merged = await ctx.deps.notebooks.mergeRun(
            input.notebook.path,
            {
              cells: captured.filter((cell) => cell.state !== "skipped").map((cell) => ({ id: cell.id, source: cell.source, outputs: cell.outputs, executionCount: cell.executionCount })),
              outputDir: dirShown,
            },
            handle.live.controller.signal,
          )
          message = `Wrote the outputs of ${captured.filter((cell) => cell.state !== "skipped").length} cell(s) into ${shownPath(target.absolute, ctx.deps.directory)} (${merged.hash}).`
        }
        if (!after.ok && after.code !== "RUNTIME_UNVERIFIED") {
          message = [message, "The runtime no longer passes its credential and client check, so it is tainted and will not run again; plan a fresh runtime and release this one by plan."]
            .filter(Boolean)
            .join(" ")
        }
        await finishRecord(captured.some((cell) => cell.state === "error") ? "error" : "ok")
        return message
      } catch (error) {
        failure = error
        const code = ColabError.is(error) ? error.code : undefined
        const aborted = isAbort(error) || handle.live.controller.signal.aborted
        await finishRecord(aborted ? "cancelled" : timedOut ? "timeout" : "failed", code)
        throw error
      } finally {
        handle.complete(state, failure)
      }
    }

    const task = collect()
    // The tool call waits up to `wait`; after that the run continues here, and Stop still interrupts it while the call lives.
    const stop = () => void handle.live.interrupt("interrupt").catch(() => undefined)
    ctx.call.signal.addEventListener("abort", stop, { once: true })
    let settled = false
    try {
      settled = await waitForCompletion(task, waitMs, ctx.call.signal)
    } catch (error) {
      // The abort listener already interrupted the kernel; a second interrupt would only add a request.
      if (!handle.live.controller.signal.aborted) await handle.live.interrupt("interrupt").catch(() => undefined)
      await task.catch(() => undefined)
      throw error
    } finally {
      ctx.call.signal.removeEventListener("abort", stop)
    }

    const cells = captured.map(cellResult)
    const files = [...outputPaths].map((path) => shownPath(path, ctx.deps.directory))
    if (!settled) return { state: "running", runId, runtime: found.record.id, cells, files, next: `colab_execution({ runId: "${runId}", wait: 60 })` }
    if (failure !== undefined) throw failure
    const message = await task
    const finalState = handle.live.state()
    return { state: finalState === "cancelled" ? "cancelled" : "ok", runId, runtime: found.record.id, cells, files, ...(message ? { message } : {}) }
  },
}
