/**
 * Package E's job and Enterprise-runtime plans (design §7.2):
 *
 * - `job.create` — the notebook (a local path sent as a base64 `directNotebookSource`, or a GCS object), compute from
 *   `customEnvironmentSpec` or an existing template, the run identity, the bucket, and the worst-case compute cost
 *   against the cap. The client-chosen `notebookExecutionJobId` is in the preview, so a retried create joins the first
 *   job on `ALREADY_EXISTS` (design §7.2).
 * - `job.delete` — the job record; its outputs stay in the bucket.
 * - `runtime.stop` — Enterprise runtimes are listed and stopped only by an explicit plan whose preview says what is
 *   lost. There is no idle signal, so the preview says the person may be using it (design §7.2, Q3).
 * - `runtime.delete` — the same, and the disk is deleted.
 *
 * Commit re-reads the target and answers `PLAN_CHANGED` when the notebook's hash, the template's compute, the runtime's
 * state, the bucket or the identity moved, or when the estimate is more than 10 % higher than previewed.
 */
import type { HandlerContext, PlanHandler } from "../types.js"
import { OPERATIONS } from "../../domain/actions.js"
import { ColabError } from "../../domain/errors.js"
import type { EnterpriseRuntime } from "../ports.js"
import { PRICES_AS_OF, priceOf, acceleratorShort, usd } from "./prices.js"
import { runIdentity, type RunIdentity, type EnterpriseSettings } from "./account.js"
import { budgetCheck, checkCost, chooseCompute, describeNotebook, jobNameOf, labelsFor, notebookForJob, notebookParam, payloadOf, settingsFor } from "./common.js"
import { jobId as newJobId, lastSegment } from "./ids.js"
import type { EnterpriseJob } from "../ports.js"
import { abandonJobCreate, confirmJobCreate, openJobCreate, reconcileCreate, rememberOperation } from "./runs.js"

/** The exact words the person sees before an Enterprise runtime is stopped or deleted (design §7.2, §3 principle 2). */
export const STOP_WARNING = "kernel state and running cells are lost; the disk is kept and still billed; the person may be using this runtime — there is no idle signal"

const identityKey = (identity: RunIdentity) => `${identity.as}:${identity.serviceAccount ?? identity.executionUser ?? ""}`

const displayNameFor = (name: string | undefined, fallback: string): string => {
  const base = (name ?? fallback).replace(/[\r\n]+/g, " ").trim() || "Colab notebook run"
  return base.length > 128 ? base.slice(0, 128) : base
}

const basenameOf = (path: string) => path.split("/").filter(Boolean).at(-1) ?? "notebook.ipynb"

interface JobPayload {
  readonly jobId: string
  readonly displayName: string
  readonly notebook: { readonly path?: string; readonly gcs?: string }
  readonly machine: string
  readonly accelerator?: string
  readonly acceleratorCount?: number
  readonly template?: string
  readonly timeoutMinutes: number
  readonly estimateUsd: number
  readonly maxUsd: number
  readonly outputUri: string
  readonly identity: { readonly as: "serviceAccount" | "user"; readonly serviceAccount?: string; readonly executionUser?: string }
}

interface JobFingerprint {
  readonly jobId: string
  readonly notebookHash: string
  readonly machine: string
  readonly accelerator: string
  readonly template: string
  readonly timeoutMinutes: number
  readonly estimateUsd: number
  readonly maxUsd: number
  readonly outputUri: string
  readonly identity: string
}

/** The job resource body a `job.create` (and the job request inside a schedule) sends. */
export function jobBody(input: {
  readonly displayName: string
  readonly notebook: { readonly path?: string; readonly gcs?: string }
  readonly bytes: Uint8Array
  readonly machine: string
  readonly accelerator?: string
  readonly acceleratorCount?: number
  readonly template?: string
  readonly timeoutMinutes: number
  /** The job's own output folder, `gs://<bucket>/<prefix>/<jobId>/` (review M2). */
  readonly outputUri: string
  readonly identity: RunIdentity
  readonly sessionId: string
}): Record<string, unknown> {
  const machineSpec = {
    machineType: input.machine,
    ...(input.accelerator !== undefined ? { acceleratorType: input.accelerator, acceleratorCount: input.acceleratorCount ?? 1 } : {}),
  }
  return {
    displayName: input.displayName,
    ...(input.template !== undefined ? { notebookRuntimeTemplateResourceName: input.template } : { customEnvironmentSpec: { machineSpec } }),
    ...(input.notebook.path !== undefined ? { directNotebookSource: { content: Buffer.from(input.bytes).toString("base64") } } : { gcsNotebookSource: { uri: input.notebook.gcs } }),
    gcsOutputUri: input.outputUri,
    executionTimeout: `${input.timeoutMinutes * 60}s`,
    ...(input.identity.serviceAccount !== undefined ? { serviceAccount: input.identity.serviceAccount } : { executionUser: input.identity.executionUser }),
    labels: labelsFor(input.sessionId),
  }
}

/** Re-read what the plan previewed; any move is PLAN_CHANGED (design §7.2). */
async function recheckJob(ctx: HandlerContext, payload: JobPayload, fingerprint: JobFingerprint, settings: EnterpriseSettings): Promise<{ readonly bytes: Uint8Array }> {
  if (settings.outputBase === undefined || !payload.outputUri.startsWith(settings.outputBase)) throw new ColabError("PLAN_CHANGED", "The account's output bucket changed since the preview.")
  const identity = await runIdentity(ctx.deps, settings, "job", ctx.call.signal)
  if (identityKey(identity) !== fingerprint.identity) throw new ColabError("PLAN_CHANGED", "The run identity changed since the preview.")
  const notebook = await notebookForJob(ctx, payload.notebook)
  if (notebook.hash !== fingerprint.notebookHash) throw new ColabError("PLAN_CHANGED", "The notebook changed since the preview.", { next: "Plan again and show the new preview." })
  if (payload.template !== undefined) {
    await ctx.providerRead(OPERATIONS.templatesList)
    const templates = await ctx.deps.vertex.listTemplates(ctx.account.alias, ctx.call.signal)
    const found = templates.find((entry) => entry.name === payload.template)
    const machineSpec = (found?.machineSpec ?? {}) as Record<string, unknown>
    if (!found || machineSpec.machineType !== payload.machine) throw new ColabError("PLAN_CHANGED", "The template's compute changed or the template is gone since the preview.")
  }
  const price = priceOf({ machine: payload.machine, ...(payload.accelerator !== undefined ? { accelerator: payload.accelerator } : {}), ...(payload.acceleratorCount !== undefined ? { acceleratorCount: payload.acceleratorCount } : {}), ...(ctx.deps.options.rates !== undefined ? { rates: ctx.deps.options.rates } : {}) })
  if (!price) throw new ColabError("PLAN_CHANGED", "The price of this compute is no longer known.")
  const estimate = price.usdPerHour * (payload.timeoutMinutes / 60)
  if (estimate > payload.estimateUsd * 1.1) throw new ColabError("PLAN_CHANGED", "The cost estimate rose by more than 10 % since the preview.", { next: "Plan again and show the new estimate." })
  // The cap holds even when `rates` changed between the preview and now (review LOW 5).
  if (estimate > payload.maxUsd) throw new ColabError("COST_CAP", `The worst case is now $${estimate.toFixed(2)}, over the $${payload.maxUsd.toFixed(2)} cap set at the preview.`, { next: "Plan again with a smaller machine or a shorter timeout." })
  return { bytes: notebook.bytes }
}

const jobCreate: PlanHandler<"job.create"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a job plan", { bucket: true })
    const identity = await runIdentity(ctx.deps, settings, "job", ctx.call.signal)
    const notebookRef = notebookParam(params.notebook)
    const notebook = await notebookForJob(ctx, notebookRef)
    const choice = await chooseCompute(ctx, params, "job")
    const cost = checkCost(choice, params.maxUsd, ctx)
    const budget = await budgetCheck(ctx, "job.create", cost.maxComputeUsd)
    const id = newJobId(ctx.deps.clock.now().getTime())
    const displayName = displayNameFor(params.displayName, basenameOf(notebook.ref))
    const outputUri = `${settings.outputBase!}${id}/`
    const payload: JobPayload = {
      jobId: id,
      displayName,
      notebook: notebookRef,
      machine: choice.machine,
      ...(choice.accelerator !== undefined ? { accelerator: choice.accelerator } : {}),
      ...(choice.acceleratorCount > 0 ? { acceleratorCount: choice.acceleratorCount } : {}),
      ...(choice.template !== undefined ? { template: choice.template } : {}),
      timeoutMinutes: choice.timeoutMinutes,
      estimateUsd: cost.maxComputeUsd,
      maxUsd: cost.capUsd,
      outputUri,
      identity: { as: identity.as, ...(identity.serviceAccount !== undefined ? { serviceAccount: identity.serviceAccount } : {}), ...(identity.executionUser !== undefined ? { executionUser: identity.executionUser } : {}) },
    }
    const fingerprint: JobFingerprint = {
      jobId: id,
      notebookHash: notebook.hash,
      machine: choice.machine,
      accelerator: choice.accelerator ?? "",
      template: choice.template ?? "",
      timeoutMinutes: choice.timeoutMinutes,
      estimateUsd: cost.maxComputeUsd,
      maxUsd: cost.capUsd,
      outputUri,
      identity: identityKey(identity),
    }
    return {
      preview: {
        action: "job.create",
        jobId: id,
        displayName,
        notebook: describeNotebook(notebook),
        compute: {
          source: choice.source,
          machine: choice.machine,
          accelerator: acceleratorShort(choice.accelerator),
          ...(choice.template !== undefined ? { template: choice.template } : {}),
          usdPerHour: usd(choice.price.usdPerHour),
          diskGb: choice.price.diskGb,
          pricesAsOf: PRICES_AS_OF,
        },
        executionTimeout: { minutes: choice.timeoutMinutes, seconds: choice.timeoutMinutes * 60 },
        identity: { as: identity.as, label: identity.label },
        outputBucket: settings.outputBucket,
        output: { folder: outputUri, pricesRegion: cost.pricesRegion },
        cost: {
          usdPerHour: usd(choice.price.usdPerHour),
          maxComputeUsd: usd(cost.maxComputeUsd),
          capUsd: usd(cost.capUsd),
          ceilingUsd: usd(cost.ceilingUsd),
          timeoutMinutes: cost.timeoutMinutes,
          pricesRegion: cost.pricesRegion,
          note: "excludes provisioning time and a template's own disk",
        },
        labels: labelsFor(ctx.call.sessionID),
      },
      payload: payload as unknown as Readonly<Record<string, unknown>>,
      fingerprint: fingerprint as unknown as Readonly<Record<string, unknown>>,
      ...(budget.length > 0 ? { warnings: budget } : {}),
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<JobPayload>(plan)
    const fingerprint = plan.fingerprint as unknown as JobFingerprint
    const settings = settingsFor(ctx, "a job plan", { bucket: true })
    const identity = await runIdentity(ctx.deps, settings, "job", ctx.call.signal)
    const { bytes } = await recheckJob(ctx, payload, fingerprint, settings)
    await budgetCheck(ctx, "job.create", payload.estimateUsd)
    const body = jobBody({
      displayName: payload.displayName,
      notebook: payload.notebook,
      bytes,
      machine: payload.machine,
      ...(payload.accelerator !== undefined ? { accelerator: payload.accelerator } : {}),
      ...(payload.acceleratorCount !== undefined ? { acceleratorCount: payload.acceleratorCount } : {}),
      ...(payload.template !== undefined ? { template: payload.template } : {}),
      timeoutMinutes: payload.timeoutMinutes,
      outputUri: payload.outputUri,
      identity,
      sessionId: ctx.call.sessionID,
    })
    const notebook = payload.notebook.path ?? payload.notebook.gcs
    // Settle any earlier create that was left unconfirmed before this plan may create another (reviews R1 and R3). A
    // create that Google's own 404s prove never landed is retried with its id, so a late-arriving one joins.
    const reconciled = await reconcileCreate(ctx.deps, ctx.account.alias, settings, notebook, ctx.providerRead, ctx.call.signal)
    const jobId = reconciled.status === "retry" ? reconciled.jobId : payload.jobId
    // The intent goes to the ledger before the call: a lost answer, a Stop or a crash leaves a record that blocks a
    // second create until it is reconciled.
    await openJobCreate(ctx.deps, ctx.account.alias, jobId, { ...(notebook !== undefined ? { notebook } : {}), estimatedUsd: payload.estimateUsd, summary: `Colab Enterprise job ${jobId}` })
    let created: Awaited<ReturnType<typeof ctx.deps.vertex.createJob>>
    try {
      created = await ctx.deps.vertex.createJob(ctx.account.alias, { jobId, body }, ctx.call.signal)
    } catch (error) {
      // An uncertain outcome or a Stop may still have landed: leave the record pending. A definitive refusal did not.
      if (ColabError.is(error) && (error.code === "UNCERTAIN" || error.code === "CANCELLED")) throw error
      await abandonJobCreate(ctx.deps, ctx.account.alias, jobId, ColabError.is(error) ? error.code : "UNAVAILABLE")
      throw error
    }
    rememberOperation(created.job.name, created.operation ?? "")
    await confirmJobCreate(ctx.deps, ctx.account.alias, created.job as EnterpriseJob, created.operation)
    return {
      job: created.job.name,
      id: lastSegment(created.job.name),
      state: created.job.state,
      displayName: payload.displayName,
      usdPerHour: usd(priceOf({ machine: payload.machine, ...(payload.accelerator !== undefined ? { accelerator: payload.accelerator } : {}), ...(ctx.deps.options.rates !== undefined ? { rates: ctx.deps.options.rates } : {}) })?.usdPerHour),
      estimateUsd: usd(payload.estimateUsd),
      pricesAsOf: PRICES_AS_OF,
      ...(reconciled.status === "retry" ? { message: `The earlier create ${reconciled.jobId} never landed, so this create reused its id.` } : {}),
    }
  },
}

const jobDelete: PlanHandler<"job.delete"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a job delete plan")
    await ctx.providerRead(OPERATIONS.jobsGet)
    const job = await ctx.deps.vertex.getJob(ctx.account.alias, jobNameOf(settings, params.job), ctx.call.signal)
    if (!job) throw new ColabError("NOT_FOUND", "The job was not found.", { next: "colab_jobs lists the account's jobs." })
    return {
      preview: {
        action: "job.delete",
        job: {
          id: lastSegment(job.name),
          name: job.name,
          displayName: job.displayName,
          state: job.state,
          ...(job.createTime !== undefined ? { created: job.createTime } : {}),
          ...(job.endTime !== undefined ? { ended: job.endTime } : {}),
          ...(job.schedule !== undefined ? { schedule: lastSegment(job.schedule) } : {}),
        },
        deletes: "the job record",
        keeps: "its output notebook and any other files it wrote to the bucket",
        ...(job.state === "JOB_STATE_SUCCEEDED" || job.state === "JOB_STATE_FAILED" || job.state === "JOB_STATE_CANCELLED" || job.state === "JOB_STATE_EXPIRED" || job.state === "JOB_STATE_PARTIALLY_SUCCEEDED"
          ? {}
          : { note: "whether deleting a running job stops it is unverified; L11 records it, and colab_cancel is the documented stop" }),
      },
      payload: { job: job.name },
      fingerprint: { job: job.name, state: job.state, ended: job.endTime ?? "" },
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ job: string }>(plan)
    const fingerprint = plan.fingerprint as unknown as { job: string; state: string; ended: string }
    settingsFor(ctx, "a job delete plan")
    await ctx.providerRead(OPERATIONS.jobsGet)
    const job = await ctx.deps.vertex.getJob(ctx.account.alias, payload.job, ctx.call.signal)
    if (!job || job.state !== fingerprint.state || (job.endTime ?? "") !== fingerprint.ended) throw new ColabError("PLAN_CHANGED", "The job changed or is gone since the preview.")
    await ctx.deps.vertex.deleteJob(ctx.account.alias, job.name, ctx.call.signal)
    return { id: lastSegment(job.name), deleted: true }
  },
}

async function findRuntime(ctx: HandlerContext, runtime: string): Promise<EnterpriseRuntime> {
  await ctx.providerRead(OPERATIONS.notebookRuntimesList)
  const runtimes = await ctx.deps.vertex.listRuntimes(ctx.account.alias, ctx.call.signal)
  const found = runtimes.find((entry) => entry.name === runtime || lastSegment(entry.name) === runtime)
  if (!found) throw new ColabError("NOT_FOUND", "The Enterprise runtime was not found.", { next: "colab_status and colab_runtimes list the account's runtimes." })
  return found
}

/** A runtime's $/h, from its own machine or the template it came from; undefined when the table cannot price it. */
async function runtimePrice(ctx: HandlerContext, runtime: EnterpriseRuntime): Promise<ReturnType<typeof priceOf>> {
  let machine = runtime.machineType
  let accelerator = runtime.accelerator
  if (!machine && runtime.template) {
    await ctx.providerRead(OPERATIONS.templatesList)
    const templates = await ctx.deps.vertex.listTemplates(ctx.account.alias, ctx.call.signal)
    const found = templates.find((template) => template.name === runtime.template)
    const machineSpec = (found?.machineSpec ?? {}) as Record<string, unknown>
    if (typeof machineSpec.machineType === "string") machine = machineSpec.machineType
    if (typeof machineSpec.acceleratorType === "string") accelerator = machineSpec.acceleratorType
  }
  if (!machine) return undefined
  return priceOf({ machine, ...(accelerator !== undefined ? { accelerator } : {}), ...(ctx.deps.options.rates !== undefined ? { rates: ctx.deps.options.rates } : {}) })
}

const runtimeView = async (ctx: HandlerContext, runtime: EnterpriseRuntime) => {
  const price = await runtimePrice(ctx, runtime)
  return {
    id: lastSegment(runtime.name),
    name: runtime.name,
    state: runtime.state,
    ...(runtime.machineType !== undefined ? { machine: runtime.machineType } : {}),
    ...(runtime.template !== undefined ? { template: lastSegment(runtime.template) } : {}),
    ...(price ? { usdPerHour: usd(price.usdPerHour) } : {}),
    ...(runtime.idleShutdownMinutes !== undefined ? { idleShutdownMinutes: runtime.idleShutdownMinutes } : {}),
    ...(runtime.euc !== undefined ? { euc: runtime.euc } : {}),
  }
}

const runtimeStop: PlanHandler<"runtime.stop"> = {
  async preview(params, ctx) {
    settingsFor(ctx, "a runtime stop plan")
    const runtime = await findRuntime(ctx, params.runtime)
    const view = await runtimeView(ctx, runtime)
    return {
      preview: {
        action: "runtime.stop",
        runtime: view,
        warning: STOP_WARNING,
        loses: "kernel state and any running cells",
        keeps: "the disk, which is still billed while the runtime is stopped",
        note: "there is no idle signal, so the plan cannot tell whether the person is using it",
      },
      payload: { runtime: runtime.name },
      fingerprint: { runtime: runtime.name, state: runtime.state },
      ...(runtime.idleShutdownMinutes === null ? { warnings: ["IDLE_SHUTDOWN_OFF" as const] } : {}),
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ runtime: string }>(plan)
    const fingerprint = plan.fingerprint as unknown as { runtime: string; state: string }
    settingsFor(ctx, "a runtime stop plan")
    const runtime = await findRuntime(ctx, payload.runtime)
    if (runtime.state !== fingerprint.state) throw new ColabError("PLAN_CHANGED", "The runtime's state changed since the preview.", { next: "Plan again and show the new state." })
    await ctx.deps.vertex.stopRuntime(ctx.account.alias, runtime.name, ctx.call.signal)
    return { runtime: lastSegment(runtime.name), state: "STOPPING" }
  },
}

const runtimeDelete: PlanHandler<"runtime.delete"> = {
  async preview(params, ctx) {
    settingsFor(ctx, "a runtime delete plan")
    const runtime = await findRuntime(ctx, params.runtime)
    const view = await runtimeView(ctx, runtime)
    return {
      preview: {
        action: "runtime.delete",
        runtime: view,
        warning: STOP_WARNING,
        loses: "kernel state, any running cells and the disk",
        deletes: "the disk is deleted",
        keeps: "nothing: the runtime and its disk are gone",
        note: "there is no idle signal, so the plan cannot tell whether the person is using it",
      },
      payload: { runtime: runtime.name },
      fingerprint: { runtime: runtime.name, state: runtime.state },
      ...(runtime.idleShutdownMinutes === null ? { warnings: ["IDLE_SHUTDOWN_OFF" as const] } : {}),
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ runtime: string }>(plan)
    const fingerprint = plan.fingerprint as unknown as { runtime: string; state: string }
    settingsFor(ctx, "a runtime delete plan")
    const runtime = await findRuntime(ctx, payload.runtime)
    if (runtime.state !== fingerprint.state) throw new ColabError("PLAN_CHANGED", "The runtime's state changed since the preview.", { next: "Plan again and show the new state." })
    await ctx.deps.vertex.deleteRuntime(ctx.account.alias, runtime.name, ctx.call.signal)
    return { runtime: lastSegment(runtime.name), deleted: true }
  },
}

export const PLAN_HANDLERS = {
  "job.create": { enterprise: jobCreate },
  "job.delete": { enterprise: jobDelete },
  "runtime.stop": { enterprise: runtimeStop },
  "runtime.delete": { enterprise: runtimeDelete },
} as const

export { jobCreate, jobDelete, runtimeStop, runtimeDelete }
