/**
 * The Vertex AI (Gemini Enterprise Agent Platform) REST client package E owns: execution jobs, schedules, notebook
 * runtimes and their templates, over `fetch` (design §1, §7.2).
 *
 * Shapes are Google's, from the v1 discovery document revision 20261107
 * (https://aiplatform.googleapis.com/$discovery/rest?version=v1) and the API reference:
 * - `projects.locations.notebookExecutionJobs` — create (query `notebookExecutionJobId`, body `NotebookExecutionJob`,
 *   returns a long-running operation), get, list (filter, orderBy, pageToken), delete; the create LRO is cancelled with
 *   `operations.cancel` (`POST v1/{operation}:cancel`), and `notebookExecutionJobs.operations.list`
 *   (`GET v1/{job}/operations`) finds a job's create operation. No `cancel` method exists on the job itself (design
 *   §9.4, L11). https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.notebookExecutionJobs
 * - `projects.locations.schedules` — create, get, list (filter, pageToken), patch (`updateMask` required), pause,
 *   resume, delete. https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.schedules
 * - `projects.locations.notebookRuntimes` — list, get, stop (LRO), delete; `notebookRuntimeTemplates.list` is
 *   read-only. https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.notebookRuntimes
 *
 * The host is the account region's locational endpoint (`<region>-aiplatform.googleapis.com`); see `vertexHost` in
 * account.ts for Google's locations and Colab Enterprise samples.
 *
 * `Schedule.maxConcurrentRunCount` is required ("Required. Maximum number of runs that can be started concurrently");
 * `Schedule.cron` takes a `TZ=`/`CRON_TZ=` prefix; `NotebookExecutionJob.executionTimeout` defaults to 86400 s;
 * `NotebookExecutionJob.gcsOutputUri` is `gs://bucket-name`; `Schedule` has no `labels` field, so the job request
 * inside it carries them.
 */
import type { PortEnv } from "../deps.js"
import { ColabError } from "../domain/errors.js"
import type { EnterpriseJob, EnterpriseRuntime, EnterpriseSchedule, Listed, VertexApi } from "../ports.js"
import { ENTERPRISE_SCOPES, enterpriseSettings, parentOf, vertexHost } from "./account.js"
import { computeOfJobBody, durationSeconds, type ScheduleOverlap } from "./detail.js"
import { GoogleHttpError, googleError, googleJson, READ_RETRIES, retryableStatus, type RetryPolicy } from "./http.js"

export interface VertexOptions {
  readonly baseUrl?: string
  readonly retryDelayMs?: number
}

// A create is safe to retry with the same client-chosen id: the retry joins the first job rather than making a second
// (design §7.2).
const CREATE: RetryPolicy = { attempts: 3, baseDelayMs: 300 }
/** A schedule create has no client-chosen id, so it is never retried by the transport (design §7.2). */
const NEVER: RetryPolicy = { attempts: 1, baseDelayMs: 0 }
const MUTATION: RetryPolicy = { attempts: 2, baseDelayMs: 300 }
/** How long the fresh lookup after a Stop may take; the person's own signal is already aborted. */
const RECONCILE_MS = 5_000
/** The client follows `nextPageToken` up to this many pages and says when the bound cut the list. */
const MAX_PAGES = 10

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined)
const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const integer = (value: unknown): number | undefined => (typeof value === "number" ? Math.trunc(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined)
const listOf = (value: unknown): readonly Record<string, unknown>[] => (Array.isArray(value) ? (value.filter((entry) => typeof entry === "object" && entry !== null) as Record<string, unknown>[]) : [])

/** An array with the page bound's verdict attached; a plain array is a complete list. */
function listed<T>(items: T[], truncated: boolean): Listed<T> {
  const array = items as T[] & { truncated?: boolean }
  if (truncated) array.truncated = true
  return array
}

/** A job resource as the port sees it. */
export function jobOf(raw: Record<string, unknown>): EnterpriseJob {
  const state = text(raw.jobState) ?? "unspecified"
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

export function scheduleOf(raw: Record<string, unknown>): EnterpriseSchedule & ScheduleOverlap {
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
    ...(integer(raw.maxConcurrentRunCount) !== undefined ? { maxConcurrentRunCount: integer(raw.maxConcurrentRunCount) } : {}),
    ...(typeof raw.allowQueueing === "boolean" ? { allowQueueing: raw.allowQueueing } : {}),
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
  const read: RetryPolicy = { ...READ_RETRIES, baseDelayMs: options.retryDelayMs ?? READ_RETRIES.baseDelayMs }
  const mutation: RetryPolicy = { ...MUTATION, baseDelayMs: options.retryDelayMs ?? MUTATION.baseDelayMs }
  const create: RetryPolicy = { ...CREATE, baseDelayMs: options.retryDelayMs ?? CREATE.baseDelayMs }

  const settings = (account: string) => enterpriseSettings(env, account, "a Colab Enterprise call")
  // The locational endpoint for the account's region (M3); `baseUrl` is the test's override.
  const baseFor = (account: string) => options.baseUrl ?? vertexHost(settings(account))

  /** One HTTP call; throws the raw Google failure so a create can recognise `ALREADY_EXISTS`. */
  async function raw(account: string, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, input: { readonly body?: unknown; readonly retry: RetryPolicy; readonly signal: AbortSignal }): Promise<Record<string, unknown>> {
    const token = await env.auth.token(account, ENTERPRISE_SCOPES, input.signal)
    return googleJson({ fetch: env.fetch, url: `${baseFor(account)}${path}`, method, token, signal: input.signal, ...(input.body === undefined ? {} : { body: input.body }), retry: input.retry })
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

  /** Every page of a list, up to the bound; `truncated` says whether more remained. */
  async function pages(account: string, path: (pageToken: string | undefined) => string, field: string, signal: AbortSignal): Promise<{ readonly items: readonly Record<string, unknown>[]; readonly truncated: boolean }> {
    const items: Record<string, unknown>[] = []
    let pageToken: string | undefined
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const answer = await call(account, "GET", path(pageToken), { retry: read, signal })
      items.push(...listOf(answer[field]))
      pageToken = text(answer.nextPageToken)
      if (!pageToken) return { items, truncated: false }
    }
    return { items, truncated: true }
  }

  const fullName = (account: string, collection: "notebookExecutionJobs" | "schedules" | "notebookRuntimes", name: string) => {
    if (name.startsWith("projects/")) return name
    return `${parentOf(settings(account))}/${collection}/${name}`
  }

  const getJob = async (account: string, name: string, signal: AbortSignal): Promise<EnterpriseJob | undefined> => {
    try {
      return jobOf(await call(account, "GET", fullName(account, "notebookExecutionJobs", name), { retry: read, signal }))
    } catch (error) {
      if (ColabError.is(error) && error.code === "NOT_FOUND") return undefined
      throw error
    }
  }

  /** A job's operations, newest page first as Google returns them; one page is enough for a create LRO. */
  const listOperations = async (account: string, job: string, signal: AbortSignal): Promise<readonly { readonly name: string; readonly done: boolean }[]> => {
    const answer = await call(account, "GET", `${fullName(account, "notebookExecutionJobs", job)}/operations?pageSize=100`, { retry: read, signal })
    return listOf(answer.operations).map((operation) => ({ name: text(operation.name) ?? "", done: operation.done === true }))
  }

  return {
    async listJobs(account, input, signal) {
      const parent = parentOf(settings(account))
      const answer = await pages(
        account,
        (pageToken) => {
          const query = new URLSearchParams({ pageSize: String(Math.min(Math.max(input.pageSize ?? 100, 1), 100)) })
          if (input.filter) query.set("filter", input.filter)
          if (input.orderBy) query.set("orderBy", input.orderBy)
          if (pageToken) query.set("pageToken", pageToken)
          return `${parent}/notebookExecutionJobs?${query.toString()}`
        },
        "notebookExecutionJobs",
        signal,
      )
      return listed(answer.items.map(jobOf), answer.truncated)
    },

    getJob(account, name, signal) {
      return getJob(account, name, signal)
    },

    async createJob(account, input, signal) {
      const parent = parentOf(settings(account))
      const name = `${parent}/notebookExecutionJobs/${input.jobId}`
      /**
       * The create's outcome is unknown: the job may exist. Look it up by the client-chosen id before answering, and by
       * the create operation too (request 4), with a fresh short signal when the caller's was aborted.
       */
      const reconcile = async (fresh: boolean): Promise<EnterpriseJob | undefined> => {
        const lookup = fresh ? AbortSignal.timeout(RECONCILE_MS) : signal
        try {
          const job = await getJob(account, name, lookup)
          if (job) return job
          const operations = await listOperations(account, name, lookup)
          if (operations.some((operation) => !operation.done)) {
            // The create is in flight: its job is not readable yet, but the id is taken. Report it as unresolved rather
            // than letting a new plan pick a new id and create a second job.
            throw new ColabError("UNCERTAIN", "The job's create operation is still running.", { next: "colab_jobs lists the account's jobs before planning again." })
          }
          return undefined
        } catch (error) {
          if (ColabError.is(error) && error.code === "UNCERTAIN") throw error
          return undefined
        }
      }
      const uncertain = (error: unknown) =>
        (error instanceof GoogleHttpError && (error.status === 409 || retryableStatus(error.status))) ||
        (ColabError.is(error) && (error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED" || error.code === "UNCERTAIN" || error.code === "CANCELLED")) ||
        (error instanceof Error && error.name === "AbortError")
      try {
        const operation = await raw(account, "POST", `${parent}/notebookExecutionJobs?notebookExecutionJobId=${encodeURIComponent(input.jobId)}`, { body: input.body, retry: create, signal })
        const created = record(operation.response)
        const job = created ? jobOf(created) : await getJob(account, name, signal)
        if (!job) throw new ColabError("UNCERTAIN", "The create answered without the job it created.", { next: "colab_jobs lists the account's jobs before planning again." })
        const operationName = text(operation.name)
        return { job, ...(operationName !== undefined ? { operation: operationName } : {}) }
      } catch (error) {
        const aborted = error instanceof Error && (error.name === "AbortError" || (ColabError.is(error) && error.code === "CANCELLED"))
        if (!uncertain(error)) throw googleError(error)
        const joined = await reconcile(aborted)
        if (aborted) {
          throw new ColabError("CANCELLED", joined ? `The call stopped, and the job ${input.jobId} was created before it did.` : "The call stopped before the job's create was confirmed.", {
            next: joined ? `colab_jobs lists the job; colab_execution({ job: "${input.jobId}" }) reads it, and a job.delete plan removes it.` : "colab_jobs lists the account's jobs before planning again.",
          })
        }
        if (joined) return { job: joined }
        throw new ColabError("UNCERTAIN", "The job create's answer was lost, and no job with its id exists.", { next: "colab_jobs lists the account's jobs before planning again." })
      }
    },

    async deleteJob(account, name, signal) {
      await call(account, "DELETE", fullName(account, "notebookExecutionJobs", name), { retry: mutation, signal })
    },

    listJobOperations(account, job, signal) {
      return listOperations(account, job, signal)
    },

    async cancelOperation(account, operation, signal) {
      // The create LRO's cancel; two attempts, because cancelling twice is harmless, and L11 decides whether it stops
      // the job (design §9.4).
      await call(account, "POST", `${operation}:cancel`, { body: {}, retry: mutation, signal })
    },

    async listSchedules(account, input, signal) {
      const parent = parentOf(settings(account))
      const answer = await pages(
        account,
        (pageToken) => {
          const query = new URLSearchParams({ pageSize: "100" })
          if (input.filter) query.set("filter", input.filter)
          if (pageToken) query.set("pageToken", pageToken)
          return `${parent}/schedules?${query.toString()}`
        },
        "schedules",
        signal,
      )
      return listed(answer.items.map(scheduleOf), answer.truncated)
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
      // Never retried: the schedule has no client-chosen id; the plan reconciles by its display-name token (§7.2).
      return scheduleOf(await call(account, "POST", `${parent}/schedules`, { body, retry: NEVER, signal }))
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
      const answer = await pages(account, (pageToken) => `${parent}/notebookRuntimes?pageSize=100${pageToken !== undefined ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`, "notebookRuntimes", signal)
      return listed(answer.items.map(runtimeOf), answer.truncated)
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
