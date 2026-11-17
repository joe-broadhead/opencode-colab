/**
 * The Enterprise branches of package D's tools (design §6, §9.4): `colab_execution({ job })`, `colab_cancel({ job })` and
 * `colab_download({ gcs })`, behind the `EnterpriseRuns` seam in `src/ports.ts`.
 *
 * A job is polled with `notebookExecutionJobs.get`; when it finishes, its result notebook is listed and read from the
 * bucket and captured like a consumer run (src/enterprise/capture.ts). Cancel goes through the create LRO's
 * `operations.cancel` — the job resource has no cancel method (Vertex v1 discovery revision 20261107; design §9.4, L11).
 * Only a job this process created has its LRO remembered; for any other job (a scheduled run, or one created before an
 * OpenCode restart) there is no documented way to find the LRO, so `JOB_UNCANCELLABLE` names what remains, and a
 * contract request asks for the operation to be recorded with the run.
 *
 * `gcsOutputUri` names a bucket; where the output notebook sits inside it is undocumented, so capture picks the newest
 * `.ipynb` written at or after the job's create time. TODO(L10): replace that with the documented layout once recorded.
 */
import { readFileSync } from "node:fs"
import { basename, extname, join } from "node:path"
import type * as z from "zod"
import type { PortEnv } from "../deps.js"
import { ColabError } from "../domain/errors.js"
import { CellResult } from "../domain/contract.js"
import type { EnterpriseJob, EnterpriseRuns, GcsApi, Ledger, RunRecord, VertexApi } from "../ports.js"
import { projectPath, resolveLocal, writeAtomic } from "./paths.js"
import { captureNotebook } from "./capture.js"
import { enterpriseSettings, type EnterpriseEnv, type EnterpriseSettings } from "./account.js"
import { isTerminal, type JobDetail } from "./detail.js"
import { sleep } from "./http.js"
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

/** What a finished job's result notebook says, saved under `<workDir>/runs/<jobId>/`; RESULTS_UNAVAILABLE when none. */
async function captureJob(env: EnterpriseRunsEnv, account: string, settings: EnterpriseSettings, job: JobDetail, input: { readonly full?: boolean; readonly signal: AbortSignal }): Promise<{ readonly cells: readonly z.output<typeof CellResult>[]; readonly files: readonly string[]; readonly truncated: boolean; readonly path: string }> {
  const runId = lastSegment(job.name)
  const prefix = job.gcsOutputUri ? `gs://${job.gcsOutputUri.replace(/^gs:\/\//, "").replace(/\/+$/, "")}/` : settings.outputPrefix
  if (!prefix) {
    throw new ColabError("BUCKET_REQUIRED", "The job names no output bucket, and the account has none to look in.", { next: "Set accounts.<alias>.outputBucket, or check the job in colab_jobs." })
  }
  const objects = await env.gcs.list(account, prefix, input.signal)
  const created = job.createTime ? Date.parse(job.createTime) : Number.NaN
  const candidates = objects
    .filter((object) => object.uri.toLowerCase().endsWith(".ipynb"))
    .filter((object) => Number.isNaN(created) || object.updated === undefined || Date.parse(object.updated) >= created - 300_000)
    .sort((a, b) => (b.updated === undefined ? 0 : Date.parse(b.updated)) - (a.updated === undefined ? 0 : Date.parse(a.updated)))
  const object = candidates[0]
  if (!object) {
    throw new ColabError("RESULTS_UNAVAILABLE", "No output notebook was found in the bucket for this job.", {
      next: "colab_jobs shows the job's state; check that the bucket is the one the job wrote to, and that the run identity can write it.",
    })
  }
  if (object.size > env.options.maxDownloadBytes) throw new ColabError("FILE_TOO_LARGE", "The job's output notebook is over maxDownloadBytes.")
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
async function record(env: EnterpriseRunsEnv, account: string, job: JobDetail, input: { readonly outputPaths?: readonly string[] } = {}): Promise<void> {
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
    ...(finished && job.state !== "JOB_STATE_SUCCEEDED"
      ? { errorCode: job.state === "JOB_STATE_EXPIRED" ? "JOB_TIMEOUT" : job.state === "JOB_STATE_CANCELLED" ? "CANCELLED" : "JOB_FAILED" }
      : {}),
    summary: existing.summary,
  }
  await env.ledger.putRun(run)
  if (finished && !existing.endedAt) await env.ledger.append({ type: "run.finished", id: runId, account })
}

/** The create half: a job this plugin started, recorded while it runs (design §5). */
export async function recordCreate(env: { readonly ledger: Ledger; readonly clock: { now(): Date } }, account: string, job: JobDetail, summary: string): Promise<void> {
  const runId = lastSegment(job.name)
  if (await env.ledger.getRun(runId)) return
  await env.ledger.putRun({
    runId,
    account,
    backend: "enterprise",
    job: job.name,
    startedAt: job.createTime ?? env.clock.now().toISOString(),
    state: "running",
    cellIds: [],
    outputPaths: [],
    summary,
  })
}

async function poll(env: EnterpriseRunsEnv, account: string, name: string, waitSeconds: number, options: RunsOptions, signal: AbortSignal): Promise<JobDetail> {
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000
  const pollMs = options.pollMs ?? 2_000
  for (;;) {
    const job = await env.vertex.getJob(account, name, signal)
    if (!job) throw new ColabError("NOT_FOUND", "The job was not found.", { next: "colab_jobs lists the account's jobs; the job may have been deleted." })
    if (isTerminal(job.state) || Date.now() >= deadline) return job
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal)
  }
}

const remaining = (job: JobDetail, now: Date) => {
  const timeout = job.executionTimeoutSeconds ?? 86_400
  const started = job.createTime ? Date.parse(job.createTime) : Number.NaN
  if (Number.isNaN(started)) return timeout
  return Math.max(0, Math.round((started + timeout * 1000 - now.getTime()) / 1000))
}

const chartsHint = (path: string): string | undefined => [".csv", ".tsv", ".json", ".jsonl", ".parquet"].includes(extname(path).toLowerCase()) ? `charts_quick({ data: { path: "${path}" } })` : undefined

export function createEnterpriseRuns(env: EnterpriseRunsEnv, options: RunsOptions = {}): EnterpriseRuns {
  return {
    async execution(account, input, signal) {
      const settings = enterpriseSettings(env, account, "colab_execution")
      const name = jobResource(settings, input.job)
      const job = await poll(env, account, name, input.wait ?? 0, options, signal)
      const id = lastSegment(job.name)
      if (!isTerminal(job.state)) {
        return { state: "running", runId: id, job: job.name, cells: [], files: [], next: `colab_execution({ job: "${id}", wait: 60 })` }
      }
      const cancelled = job.state === "JOB_STATE_CANCELLED"
      let captured: Awaited<ReturnType<typeof captureJob>>
      try {
        captured = await captureJob(env, account, settings, job, { ...(input.full !== undefined ? { full: input.full } : {}), signal })
      } catch (error) {
        if (error instanceof ColabError && (error.code === "RESULTS_UNAVAILABLE" || error.code === "FILE_TOO_LARGE") && cancelled) {
          await record(env, account, job)
          return { state: "cancelled", runId: id, job: job.name, cells: [], files: [], ...(error.code === "RESULTS_UNAVAILABLE" ? { message: "The job was cancelled before it wrote an output notebook." } : {}) }
        }
        if (error instanceof ColabError && error.code === "RESULTS_UNAVAILABLE") {
          await record(env, account, job)
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

    async cancel(account, jobName, signal) {
      const settings = enterpriseSettings(env, account, "colab_cancel")
      const name = jobResource(settings, jobName)
      const job = await env.vertex.getJob(account, name, signal)
      if (!job) throw new ColabError("NOT_FOUND", "The job was not found.", { next: "colab_jobs lists the account's jobs; it may have been deleted." })
      const id = lastSegment(job.name)
      if (isTerminal(job.state)) return { state: "ok", job: id, action: "cancelled", remainingSec: 0, message: `The job had already finished (${job.state}).` }
      const operation = operationOf(name)
      if (!operation) {
        throw new ColabError("JOB_UNCANCELLABLE", "This job has no create operation in this process, and the API has no cancel method on a job itself.", {
          next: `Wait for the timeout (${remaining(job, env.clock.now())} s left); cancellation goes through the create LRO, which only a job this process created remembers (L11).`,
        })
      }
      await env.vertex.cancelOperation(account, operation, signal)
      const deadline = Date.now() + (options.cancelWaitMs ?? 5_000)
      let observed = job
      // One read after the cancel — it is asynchronous — then poll until the wait is spent.
      for (;;) {
        const next = await env.vertex.getJob(account, name, signal)
        if (next) observed = next
        if (isTerminal(observed.state) || observed.state === "JOB_STATE_CANCELLING" || Date.now() >= deadline) break
        await sleep(Math.min(options.pollMs ?? 1_000, Math.max(1, deadline - Date.now())), signal)
      }
      if (isTerminal(observed.state)) {
        await record(env, account, observed)
        return { state: "ok", job: id, action: "cancelled", remainingSec: 0, message: `The job is ${observed.state}.` }
      }
      // Google accepts the cancel asynchronously; L11 records whether the job actually stops (design §9.4).
      return { state: "ok", job: id, action: "cancelled", remainingSec: remaining(observed, env.clock.now()), message: `Cancellation requested; the job is still ${observed.state}.` }
    },

    async downloadGcs(account, input, signal) {
      enterpriseSettings(env, account, "colab_download with a gcs source")
      if (input.gcs.endsWith("/")) throw new ColabError("INPUT_INVALID", "The gcs source is a prefix, not an object.", { next: "Pass the object's full gs:// uri." })
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
