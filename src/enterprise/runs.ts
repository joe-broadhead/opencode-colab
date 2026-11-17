/**
 * The Enterprise branches of package D's tools (design §6, §9.4): `colab_execution({ job })`, `colab_cancel({ job })` and
 * `colab_download({ gcs })`, behind the `EnterpriseRuns` seam in `src/ports.ts`.
 *
 * A job is polled with `notebookExecutionJobs.get`; when it finishes, its result notebook is read from its own output
 * folder and captured like a consumer run (src/enterprise/capture.ts). Cancel goes through the create LRO's
 * `operations.cancel` — the job resource has no cancel method (Vertex v1 discovery revision 20261107; design §9.4, L11).
 * The LRO is found in this process's map, then the ledger's `RunRecord.operation` (which survives a restart), then
 * `notebookExecutionJobs.operations.list`; a job with none of those is `JOB_UNCANCELLABLE` with what remains.
 *
 * Every provider read asserts `colab.read` through the `read` callback D passes (design §10): jobs.get before a poll,
 * storage.objects.list before a folder listing, storage.objects.get before a read, operations.list before the fallback.
 */
import { readFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import type * as z from "zod"
import type { PortEnv } from "../deps.js"
import { ColabError, type ErrorCode } from "../domain/errors.js"
import { CellResult } from "../domain/contract.js"
import { OPERATIONS } from "../domain/actions.js"
import type { EnterpriseJob, EnterpriseRuns, GcsApi, Ledger, RunRecord, VertexApi } from "../ports.js"
import { projectPath, resolveLocal, writeAtomic } from "./paths.js"
import { captureNotebook } from "./capture.js"
import { enterpriseSettings, type EnterpriseEnv, type EnterpriseSettings } from "./account.js"
import { isTerminal } from "./detail.js"
import type { ProviderRead } from "../ports.js"
import { sleep } from "./http.js"
import { cut, redact } from "../redact.js"
import { lastSegment } from "./ids.js"
import { parseNotebook, sha256Of } from "./notebook.js"

export interface RunsOptions {
  /** How often `colab_execution` asks again while a job runs; 2 s in the plugin, 0 in tests. */
  readonly pollMs?: number
  /** How long `colab_cancel` waits for the cancellation to take; 5 s in the plugin, 0 in tests. */
  readonly cancelWaitMs?: number
}

export interface EnterpriseRunsEnv extends PortEnv, EnterpriseEnv {
  readonly vertex: VertexApi
  readonly gcs: GcsApi
  readonly ledger: Ledger
}

/** The create LROs this process knows, by job resource name. Never a credential; never shown. */
const operations = new Map<string, string>()

export const rememberOperation = (job: string, operation: string) => {
  if (operation !== "") operations.set(job, operation)
}
export const operationOf = (job: string) => operations.get(job)
export const forgetOperation = (job: string) => void operations.delete(job)

const terminalRunState = (state: string): RunRecord["state"] =>
  state === "JOB_STATE_SUCCEEDED" || state === "JOB_STATE_PARTIALLY_SUCCEEDED" ? "ok" : state === "JOB_STATE_CANCELLED" ? "cancelled" : state === "JOB_STATE_EXPIRED" ? "timeout" : "failed"

const jobResource = (settings: EnterpriseSettings, job: string) => (job.startsWith("projects/") ? job : `projects/${settings.project}/locations/${settings.region}/notebookExecutionJobs/${job}`)

const withSlash = (uri: string) => (uri.endsWith("/") ? uri : `${uri}/`)

/**
 * What a finished job's result notebook says, saved under `<workDir>/runs/<jobId>/`.
 *
 * Each job the plugin creates writes into its own folder (`gcsOutputUri = gs://<bucket>/<prefix>/<jobId>/`, review M2),
 * so capture reads only that folder. A job the plugin did not create (a scheduled run, or a pre-existing one) is read
 * only under its per-job folder inside its own `gcsOutputUri`; when nothing is there the answer is RESULTS_UNAVAILABLE,
 * never "the newest notebook in the bucket", which could be another job's. L10 records Google's layout inside a folder.
 */
async function captureJob(env: EnterpriseRunsEnv, account: string, settings: EnterpriseSettings, job: EnterpriseJob, input: { readonly full?: boolean; readonly signal: AbortSignal; readonly read: ProviderRead }): Promise<{ readonly cells: readonly z.output<typeof CellResult>[]; readonly files: readonly string[]; readonly truncated: boolean; readonly path: string }> {
  const runId = lastSegment(job.name)
  const folder = job.gcsOutputUri ? withSlash(job.gcsOutputUri) : undefined
  const ours = (await env.ledger.getRun(runId)) !== undefined || (folder !== undefined && folder.endsWith(`/${runId}/`))
  const prefix = ours ? folder : folder !== undefined ? `${folder}${runId}/` : settings.outputBase !== undefined ? `${settings.outputBase}${runId}/` : undefined
  if (!prefix) {
    throw new ColabError("BUCKET_REQUIRED", "The job names no output folder, and the account has none to look in.", { next: "Set accounts.<alias>.outputBucket, or check the job in colab_jobs." })
  }
  await input.read(OPERATIONS.storageObjectsList)
  const objects = await env.gcs.list(account, prefix, input.signal)
  const candidates = objects.filter((object) => object.uri.toLowerCase().endsWith(".ipynb"))
  if (candidates.length > 1) {
    const names = candidates.slice(0, 5).map((object) => object.uri).join(", ")
    throw new ColabError("RESULTS_UNAVAILABLE", `The job's output folder holds ${candidates.length} notebooks, so the result is ambiguous: ${cut(redact(names), 300)}.`, {
      next: "L10 records the layout Google uses inside a folder; until then read the notebook you expect with colab_download and its gcs uri.",
    })
  }
  const object = candidates[0]
  if (!object) {
    throw new ColabError("RESULTS_UNAVAILABLE", "No output notebook was found in the job's own output folder.", {
      next: "colab_jobs shows the job's state; check that the run identity can write the folder, and that the job wrote one.",
    })
  }
  if (object.size > env.options.maxDownloadBytes) throw new ColabError("FILE_TOO_LARGE", "The job's output notebook is over maxDownloadBytes.")
  await input.read(OPERATIONS.storageObjectsGet)
  const bytes = await env.gcs.read(account, object.uri, input.signal)
  const runDir = resolveLocal(env.directory, join(env.options.workDir, "runs", runId), env.options.allowedRoots)
  const notebookPath = join(runDir, "output.ipynb")
  let saved = bytes
  try {
    // A second poll reads back what the first wrote; nothing is replaced (read tools never overwrite, design §6).
    saved = new Uint8Array(readFileSync(notebookPath))
  } catch {
    // first capture for this run
  }
  const notebook = parseNotebook(saved)
  const capture = captureNotebook(notebook, saved, { options: env.options, directory: env.directory, runId, ...(input.full !== undefined ? { full: input.full } : {}) })
  return { ...capture, path: projectPath(env.directory, notebookPath) }
}

/** Record what the ledger knows about a job: its create, and its end once observed (design §5, §11). */
async function record(env: EnterpriseRunsEnv, account: string, job: EnterpriseJob, input: { readonly outputPaths?: readonly string[] } = {}): Promise<void> {
  const runId = lastSegment(job.name)
  const existing = await env.ledger.getRun(runId)
  // The source lists the plugin's own runs; a job somebody else started is read, not recorded (design §11).
  if (!existing) return
  const finished = isTerminal(job.state)
  const run: RunRecord = {
    runId,
    account,
    backend: "enterprise",
    job: job.name,
    startedAt: existing.startedAt,
    ...(finished ? { endedAt: job.endTime ?? env.clock.now().toISOString() } : {}),
    state: finished ? terminalRunState(job.state) : "running",
    cellIds: existing.cellIds,
    outputPaths: input.outputPaths ?? existing.outputPaths,
    ...(existing.operation !== undefined ? { operation: existing.operation } : {}),
    ...(finished && job.state !== "JOB_STATE_SUCCEEDED"
      ? { errorCode: job.state === "JOB_STATE_EXPIRED" ? "JOB_TIMEOUT" : job.state === "JOB_STATE_CANCELLED" ? "CANCELLED" : "JOB_FAILED" }
      : {}),
    summary: existing.summary,
  }
  await env.ledger.putRun(run)
  if (finished && !existing.endedAt) await env.ledger.append({ type: "run.finished", id: runId, account })
}

/** A create whose outcome is unknown: the record exists, the job may, and no second create may start until resolved. */
export const isPendingCreate = (run: RunRecord) => run.backend === "enterprise" && run.errorCode === "UNCERTAIN" && run.endedAt === undefined

/**
 * Write the create's intent **before** the API call (review R1). A crash, a Stop or a lost answer then always leaves a
 * record keyed by the client-chosen job id, which `reconcileCreate` finds before any later create.
 */
export async function openJobCreate(env: { readonly ledger: Ledger; readonly clock: { now(): Date } }, account: string, jobId: string, input: { readonly notebook?: string; readonly summary: string }): Promise<void> {
  if (await env.ledger.getRun(jobId)) return
  await env.ledger.putRun({
    runId: jobId,
    account,
    backend: "enterprise",
    ...(input.notebook !== undefined ? { notebook: input.notebook } : {}),
    startedAt: env.clock.now().toISOString(),
    state: "running",
    cellIds: [],
    outputPaths: [],
    errorCode: "UNCERTAIN",
    summary: `${input.summary} (create unconfirmed)`,
  })
}

/** The create landed: record the operation and clear the uncertainty. Also records a joined job with no pending record. */
export async function confirmJobCreate(env: { readonly ledger: Ledger; readonly clock: { now(): Date } }, account: string, job: EnterpriseJob, operation?: string): Promise<void> {
  const runId = lastSegment(job.name)
  const existing = await env.ledger.getRun(runId)
  const { errorCode: _drop, ...rest } = existing ?? { runId, account, backend: "enterprise" as const, job: job.name, startedAt: job.createTime ?? env.clock.now().toISOString(), state: "running" as const, cellIds: [], outputPaths: [], summary: `Colab Enterprise job ${runId}` }
  const finished = isTerminal(job.state)
  await env.ledger.putRun({
    ...rest,
    ...(finished ? { endedAt: job.endTime ?? env.clock.now().toISOString(), state: terminalRunState(job.state) } : { state: "running" }),
    ...(operation !== undefined && operation !== "" ? { operation } : {}),
    summary: String(rest.summary).replace(/ \(create unconfirmed\)$/, ""),
  })
}

/** A create that definitively did not land: settle its record so it no longer blocks anything. */
export async function abandonJobCreate(env: { readonly ledger: Ledger; readonly clock: { now(): Date } }, account: string, jobId: string, code: ErrorCode): Promise<void> {
  const existing = await env.ledger.getRun(jobId)
  if (!existing) return
  const { errorCode: _drop, endedAt: _old, ...rest } = existing
  await env.ledger.putRun({ ...rest, state: "failed", endedAt: env.clock.now().toISOString(), errorCode: code, summary: String(existing.summary ?? "").replace(/ \(create unconfirmed\)$/, "") })
  await env.ledger.append({ type: "run.finished", id: jobId, account })
}

export interface ReconcileEnv {
  readonly ledger: Ledger
  readonly clock: { now(): Date }
  readonly vertex: VertexApi
}

/**
 * Before a create, settle every unresolved create for this account and notebook: a job that exists or an operation still
 * running blocks the new create with UNCERTAIN; nothing at all means the earlier create never landed, so its record is
 * closed and the new one may proceed (review R1).
 */
export async function reconcileCreate(env: ReconcileEnv, account: string, settings: EnterpriseSettings, notebook: string | undefined, read: ProviderRead, signal: AbortSignal): Promise<"none" | "cleared"> {
  const pending = (await env.ledger.listRuns({ account })).filter(isPendingCreate).filter((run) => notebook === undefined || run.notebook === undefined || run.notebook === notebook)
  if (pending.length === 0) return "none"
  let cleared = false
  for (const run of pending) {
    const name = jobResource(settings, run.runId)
    await read(OPERATIONS.jobsGet)
    const job = await env.vertex.getJob(account, name, signal)
    await read(OPERATIONS.jobOperationsList)
    const operations = await env.vertex.listJobOperations(account, name, signal)
    if (job) {
      await confirmJobCreate(env, account, job, operations.find((operation) => !operation.done)?.name ?? operations[0]?.name)
      throw new ColabError("UNCERTAIN", `The earlier create ${run.runId} was left unconfirmed, and its job exists.`, {
        next: `Read it with colab_execution({ job: "${run.runId}" }), or delete it with a job.delete plan, before planning another job.`,
      })
    }
    if (operations.some((operation) => !operation.done)) {
      throw new ColabError("UNCERTAIN", `The earlier create ${run.runId} left an operation still running.`, { next: "colab_jobs lists the account's jobs before planning again." })
    }
    await abandonJobCreate(env, account, run.runId, "UNCERTAIN")
    cleared = true
  }
  return cleared ? "cleared" : "none"
}

async function poll(env: EnterpriseRunsEnv, account: string, name: string, waitSeconds: number, options: RunsOptions, signal: AbortSignal, read: ProviderRead): Promise<EnterpriseJob> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  const pollMs = options.pollMs ?? 2_000
  for (;;) {
    await read(OPERATIONS.jobsGet)
    const job = await env.vertex.getJob(account, name, signal)
    if (!job) throw new ColabError("NOT_FOUND", "The job was not found.", { next: "colab_jobs lists the account's jobs; the job may have been deleted." })
    if (isTerminal(job.state) || Date.now() >= deadline) return job
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal)
  }
}

const remaining = (job: EnterpriseJob, now: Date) => {
  const timeout = job.executionTimeoutSeconds ?? 86_400
  const started = job.createTime ? Date.parse(job.createTime) : Number.NaN
  if (Number.isNaN(started)) return timeout
  return Math.max(0, Math.round((started + timeout * 1000 - now.getTime()) / 1000))
}

const chartsHint = (path: string): string | undefined => [".csv", ".tsv", ".json", ".jsonl", ".parquet"].includes(extname(path).toLowerCase()) ? `charts_quick({ data: { path: "${path}" } })` : undefined

export function createEnterpriseRuns(env: EnterpriseRunsEnv, options: RunsOptions = {}): EnterpriseRuns {
  return {
    async execution(account, input, signal, read) {
      const settings = enterpriseSettings(env, account, "colab_execution")
      const name = jobResource(settings, input.job)
      const job = await poll(env, account, name, input.wait ?? 0, options, signal, read)
      const id = lastSegment(job.name)
      if (!isTerminal(job.state)) {
        return { state: "running", runId: id, job: job.name, cells: [], files: [], next: `colab_execution({ job: "${id}", wait: 60 })` }
      }
      const cancelled = job.state === "JOB_STATE_CANCELLED"
      let captured: Awaited<ReturnType<typeof captureJob>>
      try {
        captured = await captureJob(env, account, settings, job, { ...(input.full !== undefined ? { full: input.full } : {}), signal, read })
      } catch (error) {
        if (error instanceof ColabError && (error.code === "RESULTS_UNAVAILABLE" || error.code === "FILE_TOO_LARGE") && cancelled) {
          await record(env, account, job)
          return { state: "cancelled", runId: id, job: job.name, cells: [], files: [], ...(error.code === "RESULTS_UNAVAILABLE" ? { message: "The job was cancelled before it wrote an output notebook." } : {}) }
        }
        if (error instanceof ColabError && error.code === "RESULTS_UNAVAILABLE") {
          await record(env, account, job)
          // A job that succeeded has results; if its folder has none or several, that is RESULTS_UNAVAILABLE, not a
          // failure of the job (review M2). A job that failed with nothing to read is its own failure.
          if (job.state === "JOB_STATE_SUCCEEDED" || job.state === "JOB_STATE_PARTIALLY_SUCCEEDED") throw error
          const code = remaining(job, env.clock.now()) === 0 ? "JOB_TIMEOUT" : "JOB_FAILED"
          throw new ColabError(code, `The job ended ${job.state} and no output notebook was found.`, { next: "colab_jobs shows the job's state and error; check the bucket the job wrote to." })
        }
        throw error
      }
      await record(env, account, job, { outputPaths: captured.files })
      const cells = input.cell === undefined ? captured.cells : captured.cells.filter((cell, index) => cell.id === input.cell || String(index) === input.cell)
      if (input.cell !== undefined && cells.length === 0) throw new ColabError("NOT_FOUND", "The job's output notebook has no cell with that id or index.", { next: "colab_execution({ job }) lists every cell." })
      const base = { runId: id, job: job.name, cells: [...cells], files: [...captured.files], truncated: captured.truncated }
      if (cancelled) return { state: "cancelled", ...base, message: `The job was cancelled; its output notebook is saved at ${captured.path}.`, trust: "untrusted" }
      if (job.state === "JOB_STATE_SUCCEEDED") return { state: "ok", ...base, trust: "untrusted" }
      return { state: "ok", ...base, message: `The job ended ${job.state}; its output notebook is saved at ${captured.path}.`, trust: "untrusted" }
    },

    async cancel(account, jobName, signal, read) {
      const settings = enterpriseSettings(env, account, "colab_cancel")
      const name = jobResource(settings, jobName)
      await read(OPERATIONS.jobsGet)
      const job = await env.vertex.getJob(account, name, signal)
      if (!job) throw new ColabError("NOT_FOUND", "The job was not found.", { next: "colab_jobs lists the account's jobs; it may have been deleted." })
      const id = lastSegment(job.name)
      if (isTerminal(job.state)) return { state: "ok", job: id, action: "cancelled", remainingSec: 0, message: `The job had already finished (${job.state}).` }
      // The create LRO: this process's map, then the ledger (which survives a restart), then the operations list.
      const recorded = (await env.ledger.getRun(id))?.operation
      let operation = operationOf(name) ?? recorded
      if (!operation) {
        await read(OPERATIONS.jobOperationsList)
        const listed = await env.vertex.listJobOperations(account, name, signal)
        operation = listed.find((entry) => !entry.done)?.name ?? listed[0]?.name
      }
      if (!operation) {
        throw new ColabError("JOB_UNCANCELLABLE", "This job has no create operation in this process or the ledger, and none is listed for the job.", {
          next: `Wait for the timeout (${remaining(job, env.clock.now())} s left); cancellation goes through the create LRO (L11).`,
        })
      }
      await env.vertex.cancelOperation(account, operation, signal)
      const deadline = Date.now() + (options.cancelWaitMs ?? 5_000)
      let observed = job
      // One read after the cancel — it is asynchronous — then poll until the wait is spent.
      for (;;) {
        await read(OPERATIONS.jobsGet)
        const next = await env.vertex.getJob(account, name, signal)
        if (next) observed = next
        if (isTerminal(observed.state) || observed.state === "JOB_STATE_CANCELLING" || Date.now() >= deadline) break
        await sleep(Math.min(options.pollMs ?? 1_000, Math.max(1, deadline - Date.now())), signal)
      }
      if (isTerminal(observed.state)) {
        await record(env, account, observed)
        return { state: "ok", job: id, action: "cancelled", remainingSec: 0, message: `The job is ${observed.state}.` }
      }
      // Google accepted the cancel asynchronously, and the job had not stopped when the call returned: say so, rather
      // than claiming it stopped. L11 records whether it does (design §9.4); `cancel-requested` is the contract's own
      // state for exactly this moment.
      return { state: "ok", job: id, action: "cancel-requested", remainingSec: remaining(observed, env.clock.now()), message: `Cancellation requested; the job is still ${observed.state}.` }
    },

    async downloadGcs(account, input, signal, read) {
      enterpriseSettings(env, account, "colab_download with a gcs source")
      if (input.gcs.endsWith("/")) throw new ColabError("INPUT_INVALID", "The gcs source is a prefix, not an object.", { next: "Pass the object's full gs:// uri." })
      await read(OPERATIONS.storageObjectsGet)
      const bytes = await env.gcs.read(account, input.gcs, signal)
      if (bytes.length > env.options.maxDownloadBytes) throw new ColabError("FILE_TOO_LARGE", "The object is over maxDownloadBytes.", { next: "Raise maxDownloadBytes, or read the object another way." })
      const relative = input.to ?? join(env.options.workDir, "files", basename(input.gcs))
      const target = resolveLocal(env.directory, relative, env.options.allowedRoots)
      writeAtomic(target, bytes, input.overwrite ?? false)
      const path = projectPath(env.directory, target)
      const hint = chartsHint(path)
      return { state: "ok", path, bytes: bytes.length, sha256: sha256Of(bytes), ...(hint !== undefined ? { charts: hint } : {}) }
    },
  }
}
