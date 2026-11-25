/**
 * Package E's Vertex AI fake: Day 0's `FakeVertex` (test/fakes/index.ts), with what the Enterprise plans and the
 * `colab_execution` path need and the Day 0 fake does not model — the job body a create sent, client-chosen ids joining
 * on ALREADY_EXISTS, a create LRO that `operations.cancel` can stop (or not, for L11's other answer), schedules that keep
 * their embedded job request, and configurable failures for the uncertain-answer paths.
 *
 * Shaped after the Vertex v1 discovery document revision 20261107 (notebookExecutionJobs, schedules, notebookRuntimes,
 * notebookRuntimeTemplates); no network, no Google call.
 */
import { ColabError } from "../../src/domain/errors.js"
import type { EnterpriseJob, EnterpriseSchedule, EnterpriseRuntime } from "../../src/provider/ports.js"
import { FakeClock, FakeVertex } from "./index.js"

export interface ScriptedJob extends EnterpriseJob {
  readonly updateTime?: string
  readonly machineType?: string
  readonly acceleratorType?: string
  readonly executionTimeoutSeconds?: number
  readonly template?: string
}

export class ScriptedVertex extends FakeVertex {
  /** Every job create the plugin sent, in order. */
  readonly jobBodies: { readonly account: string; readonly jobId: string; readonly body: Readonly<Record<string, unknown>> }[] = []
  /** Every schedule create body, in order; one entry is one call (a create is never retried). */
  readonly scheduleBodies: Readonly<Record<string, unknown>>[] = []
  /** The create LRO names, in order (the base fake keeps them in `operations`, by job). */
  readonly operationNames: string[] = []
  /** False models L11's bad answer: cancel is accepted but the job keeps running. */
  cancelStops = true
  failNextCreate?: ColabError
  /** A transient failure of the next job lookup: the reconcile must keep its record UNCERTAIN. */
  failNextGetJob?: ColabError
  failNextScheduleCreate?: ColabError
  /** Model a lost answer: store the schedule, then throw UNAVAILABLE, as a timeout after the create landed would. */
  loseNextScheduleCreate = false
  private readonly operationJobs = new Map<string, string>()
  private counter = 0

  constructor(readonly clock: FakeClock = new FakeClock()) {
    super()
  }

  private now() {
    return this.clock.now().toISOString()
  }

  override async createJob(account: string, input: { readonly jobId: string; readonly body: Record<string, unknown> }) {
    this.calls.push({ method: "createJob", args: [account, input] })
    this.jobBodies.push({ account, jobId: input.jobId, body: input.body })
    if (this.failNextCreate) {
      const error = this.failNextCreate
      this.failNextCreate = undefined
      throw error
    }
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${input.jobId}`
    const existing = this.jobs.get(name) as ScriptedJob | undefined
    // A client-chosen id makes the create idempotent: the second call joins the first (design §7.2).
    if (existing) return { job: existing }
    const body = input.body
    const custom = (body.customEnvironmentSpec as { machineSpec?: Record<string, unknown> } | undefined)?.machineSpec
    const timeout = typeof body.executionTimeout === "string" ? Number(body.executionTimeout.replace(/s$/, "")) : undefined
    const job: ScriptedJob = {
      name,
      displayName: typeof body.displayName === "string" ? body.displayName : input.jobId,
      state: "JOB_STATE_RUNNING",
      createTime: this.now(),
      updateTime: this.now(),
      ...(typeof body.gcsOutputUri === "string" ? { gcsOutputUri: body.gcsOutputUri } : {}),
      ...(typeof custom?.machineType === "string" ? { machineType: custom.machineType } : {}),
      ...(typeof custom?.acceleratorType === "string" ? { acceleratorType: custom.acceleratorType } : {}),
      ...(timeout !== undefined ? { executionTimeoutSeconds: timeout } : {}),
      ...(typeof body.notebookRuntimeTemplateResourceName === "string" ? { template: body.notebookRuntimeTemplateResourceName } : {}),
    }
    this.jobs.set(name, job)
    const operation = `projects/proj/locations/us-central1/operations/op-${++this.counter}`
    this.operationNames.push(operation)
    this.operationJobs.set(operation, name)
    this.operations.set(name, [...(this.operations.get(name) ?? []), { name: operation, done: false }])
    return { job, operation }
  }

  override async getJob(account: string, name: string) {
    this.calls.push({ method: "getJob", args: [account, name] })
    if (this.failNextGetJob) {
      const error = this.failNextGetJob
      this.failNextGetJob = undefined
      throw error
    }
    return this.jobs.get(name) as ScriptedJob | undefined
  }

  /**
   * Google answers 404 NOT_FOUND — its documented envelope, `{ "error": { "code": 404, "message", "status":
   * "NOT_FOUND" } }` (API Design Guide, errors: https://cloud.google.com/apis/design/errors) — for a job that does not
   * exist, and so for the operations under it. The port answers NOT_FOUND, not an empty list.
   */
  override async listJobOperations(account: string, job: string) {
    this.calls.push({ method: "listJobOperations", args: [account, job] })
    if (!this.jobs.has(job)) throw new ColabError("NOT_FOUND", "The job was not found, so it has no operations (a 404 NOT_FOUND with Google's documented error body).")
    return this.operations.get(job) ?? []
  }

  /** Moves a job to a terminal (or any) state, as Google would. */
  setJobState(name: string, state: string) {
    const job = this.jobs.get(name)
    if (!job) throw new Error(`no job ${name}`)
    const terminal = state === "JOB_STATE_SUCCEEDED" || state === "JOB_STATE_FAILED" || state === "JOB_STATE_CANCELLED" || state === "JOB_STATE_EXPIRED"
    this.jobs.set(name, { ...job, state, updateTime: this.now(), ...(terminal ? { endTime: this.now() } : {}) } as EnterpriseJob)
  }

  /** Adds a job the plugin did not create, such as a scheduled run. The client maps `updateTime` to `endTime`. */
  putJob(job: EnterpriseJob & { readonly updateTime?: string; readonly machineType?: string; readonly acceleratorType?: string; readonly executionTimeoutSeconds?: number }) {
    this.jobs.set(job.name, { ...job, ...(job.endTime === undefined && job.updateTime !== undefined ? { endTime: job.updateTime } : {}) } as EnterpriseJob)
  }

  override async cancelOperation(account: string, operation: string) {
    this.calls.push({ method: "cancelOperation", args: [account, operation] })
    if (!this.cancelStops) return
    const name = this.operationJobs.get(operation)
    if (name) this.setJobState(name, "JOB_STATE_CANCELLED")
  }

  override async createSchedule(account: string, body: Record<string, unknown>) {
    this.calls.push({ method: "createSchedule", args: [account, body] })
    this.scheduleBodies.push(body)
    if (this.failNextScheduleCreate) {
      const error = this.failNextScheduleCreate
      this.failNextScheduleCreate = undefined
      throw error
    }
    const lost = this.loseNextScheduleCreate
    this.loseNextScheduleCreate = false
    const name = `projects/proj/locations/us-central1/schedules/${Number(String(this.schedules.size + 1))}`
    const schedule: EnterpriseSchedule & { jobRequest?: Readonly<Record<string, unknown>> } = {
      name,
      displayName: String(body.displayName),
      cron: String(body.cron),
      state: "ACTIVE",
      ...(body.maxRunCount !== undefined ? { maxRunCount: Number(body.maxRunCount) } : {}),
      ...(typeof body.endTime === "string" ? { endTime: body.endTime } : {}),
      startedRunCount: 0,
      jobRequest: body.createNotebookExecutionJobRequest as Readonly<Record<string, unknown>>,
      ...(body.maxConcurrentRunCount !== undefined ? { maxConcurrentRunCount: Number(body.maxConcurrentRunCount) } : {}),
      ...(body.allowQueueing !== undefined ? { allowQueueing: body.allowQueueing === true } : {}),
    }
    this.schedules.set(name, schedule)
    if (lost) throw new ColabError("UNAVAILABLE", "The create's answer was lost.")
    return schedule
  }

  override async updateSchedule(account: string, name: string, body: Record<string, unknown>) {
    this.calls.push({ method: "updateSchedule", args: [account, name, body] })
    const schedule = this.schedules.get(name)
    if (!schedule) throw new ColabError("NOT_FOUND")
    const { updateMask: _mask, ...fields } = body
    const next: EnterpriseSchedule & { jobRequest?: Readonly<Record<string, unknown>> } = {
      ...schedule,
      ...(typeof fields.cron === "string" ? { cron: fields.cron } : {}),
      ...(fields.maxRunCount !== undefined ? { maxRunCount: Number(fields.maxRunCount) } : {}),
      ...(typeof fields.endTime === "string" ? { endTime: fields.endTime } : {}),
    }
    this.schedules.set(name, next)
    return next
  }

  /** A runtime to list, stop or delete (Enterprise runtimes are never the plugin's own). */
  putRuntime(runtime: EnterpriseRuntime) {
    this.runtimes.set(runtime.name, runtime)
  }
}
