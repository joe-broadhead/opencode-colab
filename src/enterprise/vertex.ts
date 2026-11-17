/**
 * The Vertex AI (Gemini Enterprise Agent Platform) REST client package E owns: execution jobs, schedules, notebook
 * runtimes and their templates, over `fetch` (design §1, §7.2).
 *
 * Shapes are Google's, from the v1 discovery document revision 20261107
 * (https://aiplatform.googleapis.com/$discovery/rest?version=v1) and the API reference:
 * - `projects.locations.notebookExecutionJobs` — create (query `notebookExecutionJobId`, body `NotebookExecutionJob`,
 *   returns a long-running operation), get, list, delete; the create LRO is cancelled with `operations.cancel`
 *   (`POST v1/{operation}:cancel`). No `cancel` method exists on the job itself (design §9.4, L11).
 *   https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.notebookExecutionJobs
 * - `projects.locations.schedules` — create, get, list, patch (`updateMask` required), pause, resume, delete.
 *   https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.schedules
 * - `projects.locations.notebookRuntimes` — list, get, stop (LRO), delete; `notebookRuntimeTemplates.list` is read-only.
 *   https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.notebookRuntimes
 *
 * `Schedule.maxConcurrentRunCount` is required ("Required. Maximum number of runs that can be started concurrently");
 * `Schedule.cron` takes a `TZ=`/`CRON_TZ=` prefix; `NotebookExecutionJob.executionTimeout` defaults to 86400 s;
 * `NotebookExecutionJob.gcsOutputUri` is `gs://bucket-name`; `Schedule` has no `labels` field, so the job request
 * inside it carries them.
 */
import type { PortEnv } from "../deps.js"
import { ColabError } from "../domain/errors.js"
import type { EnterpriseRuntime, VertexApi } from "../ports.js"
import { ENTERPRISE_SCOPES, enterpriseSettings, parentOf } from "./account.js"
import { computeOfJobBody, durationSeconds, type JobDetail, type ScheduleDetail } from "./detail.js"
import { GoogleHttpError, googleError, googleJson, READ_RETRIES, type RetryPolicy } from "./http.js"

export interface VertexOptions {
  readonly baseUrl?: string
  readonly retryDelayMs?: number
}

const DEFAULT_BASE = "https://aiplatform.googleapis.com/v1/"
const CREATE: RetryPolicy = { attempts: 1, baseDelayMs: 0 }
const MUTATION: RetryPolicy = { attempts: 2, baseDelayMs: 300 }

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const integer = (value: unknown): number | undefined => (typeof value === "number" ? Math.trunc(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined)
const listOf = (value: unknown): readonly Record<string, unknown>[] => (Array.isArray(value) ? (value.filter((entry) => typeof entry === "object" && entry !== null) as Record<string, unknown>[]) : [])

/** A job resource as the port and package E's detail view see it. */
export function jobOf(raw: Record<string, unknown>): JobDetail {
  const state = text(raw.jobState) ?? "JOB_STATE_UNSPECIFIED"
  const compute = computeOfJobBody(raw)
  const status = record(raw.status)
  const terminal = ["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"].includes(state)
  return {
    name: text(raw.name) ?? "",
    displayName: text(raw.displayName) ?? "",
    state,
    ...(text(raw.createTime) !== undefined ? { createTime: text(raw.createTime) } : {}),
    ...(terminal && text(raw.updateTime) !== undefined ? { endTime: text(raw.updateTime) } : {}),
    ...(text(raw.gcsOutputUri) !== undefined ? { gcsOutputUri: text(raw.gcsOutputUri) } : {}),
    ...(text(raw.scheduleResourceName) !== undefined ? { schedule: text(raw.scheduleResourceName) } : {}),
    ...(text(status?.message) !== undefined ? { error: text(status?.message) } : {}),
    ...(compute.machine !== undefined ? { machineType: compute.machine } : {}),
    ...(compute.accelerator !== undefined ? { acceleratorType: compute.accelerator } : {}),
    ...(compute.acceleratorCount !== undefined ? { acceleratorCount: compute.acceleratorCount } : {}),
    ...(compute.timeoutSeconds !== undefined ? { executionTimeoutSeconds: compute.timeoutSeconds } : {}),
    ...(compute.template !== undefined ? { template: compute.template } : {}),
  }
}

export function scheduleOf(raw: Record<string, unknown>): ScheduleDetail {
  return {
    name: text(raw.name) ?? "",
    displayName: text(raw.displayName) ?? "",
    cron: text(raw.cron) ?? "",
    state: text(raw.state) ?? "unspecified",
    ...(integer(raw.maxRunCount) !== undefined ? { maxRunCount: integer(raw.maxRunCount) } : {}),
    ...(text(raw.endTime) !== undefined ? { endTime: text(raw.endTime) } : {}),
    ...(integer(raw.startedRunCount) !== undefined ? { startedRunCount: integer(raw.startedRunCount) } : {}),
    ...(record(raw.createNotebookExecutionJobRequest) !== undefined ? { jobRequest: record(raw.createNotebookExecutionJobRequest)! } : {}),
    ...(text(raw.nextRunTime) !== undefined ? { nextRunTime: text(raw.nextRunTime) } : {}),
  }
}

export function runtimeOf(raw: Record<string, unknown>): EnterpriseRuntime {
  const machineSpec = record(raw.machineSpec)
  const idle = record(raw.idleShutdownConfig)
  const eucConfig = record(raw.eucConfig)
  const ref = record(raw.notebookRuntimeTemplateRef)
  let idleShutdownMinutes: number | null | undefined
  if (idle !== undefined) {
    if (idle.idleShutdownDisabled === true) idleShutdownMinutes = null
    else if (durationSeconds(idle.idleTimeout) !== undefined) idleShutdownMinutes = Math.round(durationSeconds(idle.idleTimeout)! / 60)
  }
  return {
    name: text(raw.name) ?? "",
    state: text(raw.runtimeState) ?? "unspecified",
    ...(text(machineSpec?.machineType) !== undefined ? { machineType: text(machineSpec?.machineType) } : {}),
    ...(text(machineSpec?.acceleratorType) !== undefined ? { accelerator: text(machineSpec?.acceleratorType) } : {}),
    ...(text(ref?.notebookRuntimeTemplate) !== undefined ? { template: text(ref?.notebookRuntimeTemplate) } : {}),
    ...(idleShutdownMinutes !== undefined ? { idleShutdownMinutes } : {}),
    ...(eucConfig !== undefined ? { euc: eucConfig.eucDisabled !== true } : {}),
  }
}

/** The Vertex API over `fetch`; every call authenticates with the account's enterprise token first. */
export function createVertex(env: PortEnv, options: VertexOptions = {}): VertexApi {
  const base = options.baseUrl ?? DEFAULT_BASE
  const read: RetryPolicy = { ...READ_RETRIES, baseDelayMs: options.retryDelayMs ?? READ_RETRIES.baseDelayMs }
  const mutation: RetryPolicy = { ...MUTATION, baseDelayMs: options.retryDelayMs ?? MUTATION.baseDelayMs }

  const settings = (account: string) => enterpriseSettings(env, account, "a Colab Enterprise call")

  /** One HTTP call; throws the raw Google failure so a create can recognise `ALREADY_EXISTS`. */
  async function raw(account: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input: { readonly body?: unknown; readonly retry: RetryPolicy; readonly signal: AbortSignal }): Promise<Record<string, unknown>> {
    const token = await env.auth.token(account, ENTERPRISE_SCOPES, input.signal)
    return googleJson({ fetch: env.fetch, url: `${base}${path}`, method, token, signal: input.signal, ...(input.body === undefined ? {} : { body: input.body }), retry: input.retry })
  }

  /** One HTTP call whose Google failure becomes the plugin's code. */
  async function call(account: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input: { readonly body?: unknown; readonly retry: RetryPolicy; readonly signal: AbortSignal }): Promise<Record<string, unknown>> {
    try {
      return await raw(account, method, path, input)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      throw googleError(error)
    }
  }

  const fullName = (account: string, collection: "notebookExecutionJobs" | "schedules" | "notebookRuntimes", name: string) => {
    if (name.startsWith("projects/")) return name
    return `${parentOf(settings(account))}/${collection}/${name}`
  }

  const getJob = async (account: string, name: string, signal: AbortSignal): Promise<JobDetail | undefined> => {
    try {
      return jobOf(await call(account, "GET", fullName(account, "notebookExecutionJobs", name), { retry: read, signal }))
    } catch (error) {
      if (ColabError.is(error) && error.code === "NOT_FOUND") return undefined
      throw error
    }
  }

  return {
    async listJobs(account, input, signal) {
      const parent = parentOf(settings(account))
      const query = new URLSearchParams({ pageSize: String(Math.min(Math.max(input.pageSize ?? 100, 1), 100)) })
      if (input.filter) query.set("filter", input.filter)
      const answer = await call(account, "GET", `${parent}/notebookExecutionJobs?${query.toString()}`, { retry: read, signal })
      return listOf(answer.notebookExecutionJobs).map(jobOf)
    },

    getJob(account, name, signal) {
      return getJob(account, name, signal)
    },

    async createJob(account, input, signal) {
      const parent = parentOf(settings(account))
      const name = `${parent}/notebookExecutionJobs/${input.jobId}`
      try {
        const operation = await raw(account, "POST", `${parent}/notebookExecutionJobs?notebookExecutionJobId=${encodeURIComponent(input.jobId)}`, { body: input.body, retry: CREATE, signal })
        const created = record(operation.response)
        const job = created ? jobOf(created) : await getJob(account, name, signal)
        if (!job) throw new ColabError("UNAVAILABLE", "The create answered without the job it created.")
        return { job, operation: text(operation.name) ?? "" }
      } catch (error) {
        // A client-chosen id makes the create idempotent: a retried call joins the first job (design §7.2).
        if (error instanceof GoogleHttpError && error.status === 409 && error.reason === "ALREADY_EXISTS") {
          const joined = await getJob(account, name, signal)
          if (joined) return { job: joined, operation: "" }
        }
        if (error instanceof Error && error.name === "AbortError") throw error
        throw googleError(error)
      }
    },

    async deleteJob(account, name, signal) {
      await call(account, "DELETE", fullName(account, "notebookExecutionJobs", name), { retry: mutation, signal })
    },

    async cancelOperation(account, operation, signal) {
      // The create LRO's cancel; one attempt, because a cancel is not a read and L11 decides what it does (design §9.4).
      await call(account, "POST", `${operation}:cancel`, { body: {}, retry: CREATE, signal })
    },

    async listSchedules(account, signal) {
      const parent = parentOf(settings(account))
      const answer = await call(account, "GET", `${parent}/schedules?pageSize=100`, { retry: read, signal })
      return listOf(answer.schedules).map(scheduleOf)
    },

    async getSchedule(account, name, signal) {
      try {
        return scheduleOf(await call(account, "GET", fullName(account, "schedules", name), { retry: read, signal }))
      } catch (error) {
        if (ColabError.is(error) && error.code === "NOT_FOUND") return undefined
        throw error
      }
    },

    async createSchedule(account, body, signal) {
      const parent = parentOf(settings(account))
      // Never retried here: the schedule has no client-chosen id; the plan reconciles by its display-name token (§7.2).
      return scheduleOf(await call(account, "POST", `${parent}/schedules`, { body, retry: CREATE, signal }))
    },

    async updateSchedule(account, name, body, signal) {
      const { updateMask, ...schedule } = body as Record<string, unknown> & { readonly updateMask?: unknown }
      if (typeof updateMask !== "string" || updateMask.trim() === "") throw new ColabError("INPUT_INVALID", "A schedule update needs the fields it changes (updateMask).")
      const query = new URLSearchParams({ updateMask })
      return scheduleOf(await call(account, "PATCH", `${fullName(account, "schedules", name)}?${query.toString()}`, { body: schedule, retry: mutation, signal }))
    },

    async pauseSchedule(account, name, signal) {
      await call(account, "POST", `${fullName(account, "schedules", name)}:pause`, { body: {}, retry: mutation, signal })
    },

    async resumeSchedule(account, name, signal) {
      await call(account, "POST", `${fullName(account, "schedules", name)}:resume`, { body: {}, retry: mutation, signal })
    },

    async deleteSchedule(account, name, signal) {
      await call(account, "DELETE", fullName(account, "schedules", name), { retry: mutation, signal })
    },

    async listRuntimes(account, signal) {
      const parent = parentOf(settings(account))
      const answer = await call(account, "GET", `${parent}/notebookRuntimes?pageSize=100`, { retry: read, signal })
      return listOf(answer.notebookRuntimes).map(runtimeOf)
    },

    async stopRuntime(account, name, signal) {
      await call(account, "POST", `${fullName(account, "notebookRuntimes", name)}:stop`, { body: {}, retry: mutation, signal })
    },

    async deleteRuntime(account, name, signal) {
      await call(account, "DELETE", fullName(account, "notebookRuntimes", name), { retry: mutation, signal })
    },

    async listTemplates(account, signal) {
      const parent = parentOf(settings(account))
      const answer = await call(account, "GET", `${parent}/notebookRuntimeTemplates?pageSize=100`, { retry: read, signal })
      return listOf(answer.notebookRuntimeTemplates)
    },
  }
}
