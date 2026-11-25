/**
 * Package E's schedule plans (design §7.2, §8.2): create, update, resume and delete a Colab Enterprise schedule.
 *
 * Every plan is bounded and non-overlapping before it can be committed:
 * - `maxRunCount` or `endTime` is required (`SCHEDULE_UNBOUNDED`), so a forgotten schedule ends;
 * - the *minimum* gap between consecutive occurrences, over the bounded run count or a year, must be at least
 *   `executionTimeout` + `provisioningMarginMinutes` (`SCHEDULE_OVERLAP`), so a cron such as `0 9,10 * * *` is judged by
 *   its shortest gap (review round 2, LOW 1);
 * - `maxConcurrentRunCount: 1` and `allowQueueing: false` are sent, because `maxConcurrentRunCount` limits *starts* and
 *   not running jobs (discovery 20261107).
 *
 * `schedules.create` has no client-chosen id: it is never retried automatically, and an uncertain answer is reconciled
 * by listing on the plan's unique `display-name` token (design §7.2, §8.6).
 */
import type { HandlerContext, PlanHandler } from "../types.js"
import { OPERATIONS } from "../../domain/actions.js"
import { ColabError } from "../../domain/errors.js"
import type { EnterpriseSchedule } from "../ports.js"
import { PRICES_AS_OF, PRICES_REGION, acceleratorShort, priceOf, usd } from "./prices.js"
import { runIdentity, type RunIdentity } from "./account.js"
import { budgetCheck, checkCost, checkScheduleCost, chooseCompute, describeNotebook, labelsFor, notebookForJob, notebookParam, payloadOf, scheduleCompute, scheduleCost, scheduleNameOf, runsUntil, settingsFor } from "./common.js"
import { cronWithZone, minimumGap, nextRuns, occurrencesBetween, parseCron } from "./cron.js"
import { lastSegment, scheduleToken } from "./ids.js"
import { nextRunsOf } from "./common.js"
import { jobBody } from "./plans.js"
import { overlapOf } from "./detail.js"
import { GOOGLE_DEFAULT_TIMEOUT_SECONDS } from "./common.js"

/**
 * A schedule another client made may start more than one run at once (`maxConcurrentRunCount`) or queue runs
 * (`allowQueueing`), which the plugin's overlap check cannot bound (review LOW 8). Plans refuse it rather than resume it.
 */
function refuseOverlapping(schedule: EnterpriseSchedule) {
  const detail = overlapOf(schedule)
  const concurrency = detail.maxConcurrentRunCount ?? 1
  if (concurrency > 1 || detail.allowQueueing === true) {
    throw new ColabError("SCHEDULE_OVERLAP", `The schedule starts up to ${concurrency} run${concurrency === 1 ? "" : "s"} at once${detail.allowQueueing === true ? " and queues runs" : ""}, so its runs can overlap and the plugin cannot bound them.`, {
      next: "Set maxConcurrentRunCount to 1 and turn queueing off for it in the console, or plan a new schedule.",
    })
  }
}

const identityKey = (identity: RunIdentity) => `${identity.as}:${identity.serviceAccount ?? identity.executionUser ?? ""}`

const uniqueName = (base: string, token: string): string => {
  const suffix = ` [oc-${token}]`
  const clean = base.replace(/[\r\n]+/g, " ").trim() || "Colab schedule"
  return `${clean.length + suffix.length > 128 ? clean.slice(0, 128 - suffix.length) : clean}${suffix}`
}

const requireBound = (maxRunCount: number | undefined, endTime: string | undefined, now: Date) => {
  if (maxRunCount === undefined && endTime === undefined) {
    throw new ColabError("SCHEDULE_UNBOUNDED", "The schedule has neither maxRunCount nor endTime, so it would run until somebody remembers it.", { next: "Pass maxRunCount or endTime (or both) in the plan's params." })
  }
  if (endTime !== undefined && !Number.isFinite(Date.parse(endTime))) throw new ColabError("INPUT_INVALID", "endTime is not a date the plugin can read.", { next: "Pass an RFC 3339 time, such as 2026-12-31T23:00:00Z." })
  if (endTime !== undefined && Date.parse(endTime) <= now.getTime()) throw new ColabError("INPUT_INVALID", "endTime is in the past, so the schedule would never run.", { next: "Pass a future endTime, or use maxRunCount." })
}

/** The cron's shortest gap against executionTimeout + the provisioning margin (design §7.2, §8.2). */
function checkOverlap(cronText: string, timeoutMinutes: number, runs: number | undefined, ctx: HandlerContext): { readonly minimumGapMinutes?: number; readonly requiredGapMinutes: number; readonly occurrences: number } {
  const cron = parseCron(cronText)
  const measured = minimumGap(cron, ctx.deps.clock.now(), runs !== undefined ? { runs } : {})
  const requiredGapMinutes = timeoutMinutes + ctx.deps.options.provisioningMarginMinutes
  if (measured.gapMs !== Number.POSITIVE_INFINITY && measured.gapMs < requiredGapMinutes * 60_000) {
    const gapMinutes = Number((measured.gapMs / 60_000).toFixed(1))
    throw new ColabError("SCHEDULE_OVERLAP", `The cron's shortest gap is ${gapMinutes} minutes, under the ${requiredGapMinutes} minutes a run needs (the ${timeoutMinutes}-minute timeout plus ${ctx.deps.options.provisioningMarginMinutes} minutes of provisioning).`, {
      next: "Widen the cron, or shorten timeoutMinutes.",
    })
  }
  return {
    ...(measured.gapMs !== Number.POSITIVE_INFINITY ? { minimumGapMinutes: Number((measured.gapMs / 60_000).toFixed(1)) } : {}),
    requiredGapMinutes,
    occurrences: measured.occurrences,
  }
}

/** Runs in the next 30 days, capped by the schedule's remaining run count and its endTime. */
function monthlyRuns(cronText: string, ctx: HandlerContext, bounds: { readonly maxRunCount?: number; readonly endTime?: string; readonly startedRunCount?: number }): number {
  const now = ctx.deps.clock.now()
  let until = new Date(now.getTime() + 30 * 86_400_000)
  if (bounds.endTime !== undefined && Date.parse(bounds.endTime) < until.getTime()) until = new Date(Date.parse(bounds.endTime))
  let count = occurrencesBetween(parseCron(cronText), now, until)
  if (bounds.maxRunCount !== undefined) count = Math.min(count, Math.max(0, bounds.maxRunCount - (bounds.startedRunCount ?? 0)))
  return count
}

/** A schedule's $/h and its per-run worst case, resolving a template when needed. */
async function costOf(ctx: HandlerContext, schedule: EnterpriseSchedule) {
  const compute = await scheduleCompute(ctx, schedule)
  return { compute, ...scheduleCost(schedule, ctx, compute) }
}

interface SchedulePayload {
  readonly token: string
  readonly displayName: string
  readonly cron: string
  readonly maxRunCount?: number
  readonly endTime?: string
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

interface ScheduleFingerprint {
  readonly notebookHash: string
  readonly cron: string
  readonly maxRunCount: string
  readonly endTime: string
  readonly machine: string
  readonly accelerator: string
  readonly template: string
  readonly timeoutMinutes: number
  readonly estimateUsd: number
  readonly maxUsd: number
  readonly outputUri: string
  readonly identity: string
}

async function recheck(ctx: HandlerContext, payload: SchedulePayload, fingerprint: ScheduleFingerprint): Promise<{ readonly bytes: Uint8Array; readonly settings: ReturnType<typeof settingsFor>; readonly identity: RunIdentity }> {
  const settings = settingsFor(ctx, "a schedule plan", { bucket: true })
  if (settings.outputBase === undefined || !payload.outputUri.startsWith(settings.outputBase)) throw new ColabError("PLAN_CHANGED", "The account's output bucket changed since the preview.")
  const identity = await runIdentity(ctx.deps, settings, "schedule", ctx.call.signal)
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
  const price = priceOf({ machine: payload.machine, ...(payload.accelerator !== undefined ? { accelerator: payload.accelerator } : {}), ...(payload.acceleratorCount !== undefined ? { acceleratorCount: payload.acceleratorCount } : {}), region: ctx.account.region, ...(ctx.deps.options.rates !== undefined ? { rates: ctx.deps.options.rates } : {}) })
  if (!price) throw new ColabError("PLAN_CHANGED", "The price of this compute is no longer known.")
  const estimate = price.usdPerHour * (payload.timeoutMinutes / 60)
  if (estimate > fingerprint.estimateUsd * 1.1) throw new ColabError("PLAN_CHANGED", "The cost estimate rose by more than 10 % since the preview.", { next: "Plan again and show the new estimate." })
  // The cap holds even when `rates` changed between the preview and now (review LOW 5).
  if (estimate > payload.maxUsd) throw new ColabError("COST_CAP", `Each run's worst case is now $${estimate.toFixed(2)}, over the $${payload.maxUsd.toFixed(2)} cap set at the preview.`, { next: "Plan again with a smaller machine or a shorter timeout." })
  return { bytes: notebook.bytes, settings, identity }
}

const scheduleCreate: PlanHandler<"schedule.create"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a schedule plan", { bucket: true })
    const identity = await runIdentity(ctx.deps, settings, "schedule", ctx.call.signal)
    const notebookRef = notebookParam(params.notebook)
    const notebook = await notebookForJob(ctx, notebookRef)
    const choice = await chooseCompute(ctx, params, "schedule")
    const cost = checkCost(choice, params.maxUsd, ctx)
    const budget = await budgetCheck(ctx, "schedule.create", cost.maxComputeUsd)
    requireBound(params.maxRunCount, params.endTime, ctx.deps.clock.now())
    const cronText = cronWithZone(params.cron, params.timeZone)
    const overlap = checkOverlap(cronText, choice.timeoutMinutes, params.maxRunCount, ctx)
    const token = scheduleToken()
    const displayName = uniqueName(params.displayName, token)
    // Every run of this schedule writes into its own folder under the account's bucket (review M2).
    const outputUri = `${settings.outputBase!}${token}/`
    const cron = parseCron(cronText)
    const allowedRuns = params.maxRunCount ?? runsUntil(cronText, ctx, params.endTime)
    const runsPerMonth = monthlyRuns(cronText, ctx, { ...(params.maxRunCount !== undefined ? { maxRunCount: params.maxRunCount } : {}), ...(params.endTime !== undefined ? { endTime: params.endTime } : {}) })
    const payload: SchedulePayload = {
      token,
      displayName,
      cron: cronText,
      ...(params.maxRunCount !== undefined ? { maxRunCount: params.maxRunCount } : {}),
      ...(params.endTime !== undefined ? { endTime: params.endTime } : {}),
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
    const fingerprint: ScheduleFingerprint = {
      notebookHash: notebook.hash,
      cron: cronText,
      maxRunCount: params.maxRunCount === undefined ? "" : String(params.maxRunCount),
      endTime: params.endTime ?? "",
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
        action: "schedule.create",
        displayName,
        scheduleToken: token,
        cron: cronText,
        timeZone: cron.timeZone,
        nextRuns: nextRuns(cron, ctx.deps.clock.now(), 5).map((date) => date.toISOString()),
        bounds: { ...(params.maxRunCount !== undefined ? { maxRunCount: params.maxRunCount } : {}), ...(params.endTime !== undefined ? { endTime: params.endTime } : {}) },
        ...(overlap.minimumGapMinutes !== undefined ? { minimumGapMinutes: overlap.minimumGapMinutes } : {}),
        requiredGapMinutes: overlap.requiredGapMinutes,
        overlapCheckedForOccurrences: overlap.occurrences,
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
          perRunUsd: usd(cost.maxComputeUsd),
          perMonthUsd: usd(cost.maxComputeUsd * runsPerMonth),
          runsPerMonth,
          totalUsd: usd(cost.maxComputeUsd * allowedRuns),
          totalRuns: allowedRuns,
          capUsd: usd(cost.capUsd),
          ceilingUsd: usd(cost.ceilingUsd),
          pricesRegion: cost.pricesRegion,
          note: "excludes provisioning time and a template's own disk",
        },
        concurrency: { maxConcurrentRunCount: 1, allowQueueing: false },
        labels: labelsFor(ctx.call.sessionID),
      },
      payload: payload as unknown as Readonly<Record<string, unknown>>,
      fingerprint: fingerprint as unknown as Readonly<Record<string, unknown>>,
      ...(budget.length > 0 ? { warnings: budget } : {}),
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<SchedulePayload>(plan)
    const fingerprint = plan.fingerprint as unknown as ScheduleFingerprint
    const { bytes, settings, identity } = await recheck(ctx, payload, fingerprint)
    await budgetCheck(ctx, "schedule.create", payload.estimateUsd)
    requireBound(payload.maxRunCount, payload.endTime, ctx.deps.clock.now())
    const body = {
      displayName: payload.displayName,
      cron: payload.cron,
      maxConcurrentRunCount: "1",
      allowQueueing: false,
      ...(payload.maxRunCount !== undefined ? { maxRunCount: String(payload.maxRunCount) } : {}),
      ...(payload.endTime !== undefined ? { endTime: payload.endTime } : {}),
      createNotebookExecutionJobRequest: {
        parent: `projects/${settings.project}/locations/${settings.region}`,
        notebookExecutionJob: jobBody({
          displayName: `${payload.displayName}`.slice(0, 128),
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
        }),
      },
    }
    let created: EnterpriseSchedule
    let reconciled = false
    try {
      created = await ctx.deps.vertex.createSchedule(ctx.account.alias, body, ctx.call.signal)
    } catch (error) {
      // A create has no client-chosen id: an unanswered create may have landed, so look for its token with a fresh
      // short signal before answering (review M1). The create itself is never retried.
      const uncertain = ColabError.is(error) && ["UNAVAILABLE", "RATE_LIMITED", "CANCELLED", "UNCERTAIN"].includes(error.code)
      const aborted = error instanceof Error && error.name === "AbortError"
      if (!uncertain && !aborted) throw error
      await ctx.providerRead(OPERATIONS.schedulesList)
      const schedules = await ctx.deps.vertex.listSchedules(ctx.account.alias, { filter: `display_name="${payload.displayName}"` }, AbortSignal.timeout(5_000))
      const found = schedules.find((schedule) => schedule.displayName.includes(payload.token))
      if (!found) {
        throw new ColabError("UNCERTAIN", "The create's answer was lost, and no schedule with this plan's token was found.", { next: "colab_schedules lists the account's schedules before planning again." })
      }
      created = found
      reconciled = true
    }
    return {
      schedule: created.name,
      id: lastSegment(created.name),
      displayName: created.displayName,
      state: created.state,
      cron: created.cron,
      nextRuns: nextRunsOf(created, ctx).map((date) => date.toISOString()),
      perRunUsd: usd(payload.estimateUsd),
      pricesAsOf: PRICES_AS_OF,
      ...(reconciled ? { message: "The create's answer was lost; the schedule was found by its display-name token." } : {}),
    }
  },
}

const scheduleUpdate: PlanHandler<"schedule.update"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a schedule update plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, scheduleNameOf(settings, params.schedule), ctx.call.signal)
    if (!schedule) throw new ColabError("NOT_FOUND", "The schedule was not found.", { next: "colab_schedules lists the account's schedules." })
    if (schedule.state === "COMPLETED") throw new ColabError("ACTION_UNSUPPORTED", "The schedule has completed, so there is nothing to update.", { next: "Plan schedule.create for a new one." })
    const current = parseCron(schedule.cron)
    if (params.cron === undefined && params.maxRunCount === undefined && params.endTime === undefined && params.timeZone === undefined) {
      throw new ColabError("INPUT_INVALID", "The plan changes nothing: pass cron, timeZone, maxRunCount or endTime.", { next: "Pass at least one field to change." })
    }
    const cronText = params.cron !== undefined ? cronWithZone(params.cron, params.timeZone) : params.timeZone !== undefined ? cronWithZone(current.expression, params.timeZone) : schedule.cron
    const maxRunCount = params.maxRunCount ?? schedule.maxRunCount
    const endTime = params.endTime ?? schedule.endTime
    requireBound(maxRunCount, endTime, ctx.deps.clock.now())
    const cron = parseCron(cronText)
    refuseOverlapping(schedule)
    const cost = checkScheduleCost(await costOf(ctx, schedule), undefined, ctx)
    // A foreign schedule without its own timeout runs to Google's 24 h default, not the plugin's option (review M4b).
    const timeoutMinutes = cost.timeoutMinutes ?? GOOGLE_DEFAULT_TIMEOUT_SECONDS / 60
    const overlap = checkOverlap(cronText, timeoutMinutes, maxRunCount, ctx)
    const runsPerMonth = monthlyRuns(cronText, ctx, { ...(maxRunCount !== undefined ? { maxRunCount } : {}), ...(endTime !== undefined ? { endTime } : {}), ...(schedule.startedRunCount !== undefined ? { startedRunCount: schedule.startedRunCount } : {}) })
    const changes = {
      ...(cronText !== schedule.cron ? { cron: cronText } : {}),
      ...(params.maxRunCount !== undefined ? { maxRunCount: params.maxRunCount } : {}),
      ...(params.endTime !== undefined ? { endTime: params.endTime } : {}),
    }
    if (Object.keys(changes).length === 0) throw new ColabError("INPUT_INVALID", "The plan changes nothing: every value it names is already the schedule's.", { next: "Pass a different cron, timeZone, maxRunCount or endTime." })
    return {
      preview: {
        action: "schedule.update",
        schedule: { id: lastSegment(schedule.name), name: schedule.name, displayName: schedule.displayName, state: schedule.state, cron: schedule.cron, ...(schedule.startedRunCount !== undefined ? { runsStarted: schedule.startedRunCount } : {}) },
        changes,
        nextRuns: nextRuns(cron, ctx.deps.clock.now(), 5).map((date) => date.toISOString()),
        bounds: { ...(maxRunCount !== undefined ? { maxRunCount } : {}), ...(endTime !== undefined ? { endTime } : {}) },
        ...(overlap.minimumGapMinutes !== undefined ? { minimumGapMinutes: overlap.minimumGapMinutes } : {}),
        requiredGapMinutes: overlap.requiredGapMinutes,
        cost: {
          perRunUsd: usd(cost.perRun),
          perMonthUsd: usd(cost.perRun !== undefined ? cost.perRun * runsPerMonth : undefined),
          runsPerMonth,
          timeoutMinutes: cost.timeoutMinutes,
          timeoutSource: cost.timeoutSource,
          capUsd: usd(cost.capUsd),
          pricesRegion: cost.pricesRegion,
          note: "excludes provisioning time and a template's own disk",
        },
      },
      payload: { schedule: schedule.name, changes } as Readonly<Record<string, unknown>>,
      fingerprint: { schedule: schedule.name, state: schedule.state, cron: schedule.cron, maxRunCount: schedule.maxRunCount === undefined ? "" : String(schedule.maxRunCount), endTime: schedule.endTime ?? "" },
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ schedule: string; changes: { readonly cron?: string; readonly maxRunCount?: number; readonly endTime?: string } }>(plan)
    const fingerprint = plan.fingerprint as unknown as { schedule: string; state: string; cron: string; maxRunCount: string; endTime: string }
    settingsFor(ctx, "a schedule update plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, payload.schedule, ctx.call.signal)
    if (!schedule || schedule.state !== fingerprint.state || schedule.cron !== fingerprint.cron || (schedule.maxRunCount === undefined ? "" : String(schedule.maxRunCount)) !== fingerprint.maxRunCount || (schedule.endTime ?? "") !== fingerprint.endTime) {
      throw new ColabError("PLAN_CHANGED", "The schedule changed since the preview.", { next: "Plan again and show the new state." })
    }
    const maxRunCount = payload.changes.maxRunCount ?? schedule.maxRunCount
    const endTime = payload.changes.endTime ?? schedule.endTime
    requireBound(maxRunCount, endTime, ctx.deps.clock.now())
    refuseOverlapping(schedule)
    checkScheduleCost(await costOf(ctx, schedule), undefined, ctx)
    const fields = [
      ...(payload.changes.cron !== undefined ? ["cron"] : []),
      ...(payload.changes.maxRunCount !== undefined ? ["maxRunCount"] : []),
      ...(payload.changes.endTime !== undefined ? ["endTime"] : []),
    ]
    if (fields.length === 0) throw new ColabError("INPUT_INVALID", "The plan changes nothing.")
    const updated = await ctx.deps.vertex.updateSchedule(
      ctx.account.alias,
      schedule.name,
      {
        updateMask: fields.join(","),
        ...(payload.changes.cron !== undefined ? { cron: payload.changes.cron } : {}),
        ...(payload.changes.maxRunCount !== undefined ? { maxRunCount: String(payload.changes.maxRunCount) } : {}),
        ...(payload.changes.endTime !== undefined ? { endTime: payload.changes.endTime } : {}),
      },
      ctx.call.signal,
    )
    return { schedule: updated.name, id: lastSegment(updated.name), state: updated.state, cron: updated.cron, nextRuns: nextRunsOf(updated, ctx).map((date) => date.toISOString()) }
  },
}

const scheduleResume: PlanHandler<"schedule.resume"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a schedule resume plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, scheduleNameOf(settings, params.schedule), ctx.call.signal)
    if (!schedule) throw new ColabError("NOT_FOUND", "The schedule was not found.", { next: "colab_schedules lists the account's schedules." })
    if (schedule.state === "COMPLETED") throw new ColabError("ACTION_UNSUPPORTED", "The schedule has completed; resuming it would start nothing.", { next: "Plan schedule.create for a new one." })
    if (schedule.state !== "PAUSED") throw new ColabError("ACTION_UNSUPPORTED", `The schedule is ${schedule.state}, so there is nothing to resume.`, { next: "colab_schedules lists its next runs." })
    requireBound(schedule.maxRunCount, schedule.endTime, ctx.deps.clock.now())
    refuseOverlapping(schedule)
    const cost = checkScheduleCost(await costOf(ctx, schedule), undefined, ctx)
    const budget = await budgetCheck(ctx, "schedule.resume", cost.perRun)
    const cron = parseCron(schedule.cron)
    // The overlap check runs on resume too, against the schedule's own timeout or Google's 24 h default (review M4b).
    checkOverlap(schedule.cron, cost.timeoutMinutes ?? GOOGLE_DEFAULT_TIMEOUT_SECONDS / 60, schedule.maxRunCount, ctx)
    const runsPerMonth = monthlyRuns(schedule.cron, ctx, schedule)
    return {
      preview: {
        action: "schedule.resume",
        schedule: { id: lastSegment(schedule.name), name: schedule.name, displayName: schedule.displayName, state: schedule.state, cron: schedule.cron, ...(schedule.maxRunCount !== undefined ? { maxRunCount: schedule.maxRunCount } : {}), ...(schedule.endTime !== undefined ? { endTime: schedule.endTime } : {}), ...(schedule.startedRunCount !== undefined ? { runsStarted: schedule.startedRunCount } : {}) },
        nextRuns: nextRuns(cron, ctx.deps.clock.now(), 5).map((date) => date.toISOString()),
        cost: {
          perRunUsd: usd(cost.perRun),
          perMonthUsd: usd(cost.perRun !== undefined ? cost.perRun * runsPerMonth : undefined),
          runsPerMonth,
          timeoutMinutes: cost.timeoutMinutes,
          timeoutSource: cost.timeoutSource,
          capUsd: usd(cost.capUsd),
          pricesRegion: cost.pricesRegion,
          note: "excludes provisioning time and a template's own disk",
        },
        catchUp: "missed runs are not backfilled (`catchUp` is output-only and false)",
      },
      payload: { schedule: schedule.name } as Readonly<Record<string, unknown>>,
      fingerprint: { schedule: schedule.name, state: schedule.state, cron: schedule.cron, maxRunCount: schedule.maxRunCount === undefined ? "" : String(schedule.maxRunCount), endTime: schedule.endTime ?? "" },
      ...(budget.length > 0 ? { warnings: budget } : {}),
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ schedule: string }>(plan)
    const fingerprint = plan.fingerprint as unknown as { schedule: string; state: string; cron: string; maxRunCount: string; endTime: string }
    settingsFor(ctx, "a schedule resume plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, payload.schedule, ctx.call.signal)
    if (!schedule || schedule.state !== "PAUSED" || schedule.cron !== fingerprint.cron) throw new ColabError("PLAN_CHANGED", "The schedule changed since the preview.", { next: "Plan again and show the new state." })
    refuseOverlapping(schedule)
    const cost = checkScheduleCost(await costOf(ctx, schedule), undefined, ctx)
    await budgetCheck(ctx, "schedule.resume", cost.perRun)
    await ctx.deps.vertex.resumeSchedule(ctx.account.alias, schedule.name, ctx.call.signal)
    return { schedule: schedule.name, id: lastSegment(schedule.name), state: "ACTIVE", nextRuns: nextRunsOf(schedule, ctx).map((date) => date.toISOString()) }
  },
}

const scheduleDelete: PlanHandler<"schedule.delete"> = {
  async preview(params, ctx) {
    const settings = settingsFor(ctx, "a schedule delete plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, scheduleNameOf(settings, params.schedule), ctx.call.signal)
    if (!schedule) throw new ColabError("NOT_FOUND", "The schedule was not found.", { next: "colab_schedules lists the account's schedules." })
    return {
      preview: {
        action: "schedule.delete",
        schedule: {
          id: lastSegment(schedule.name),
          name: schedule.name,
          displayName: schedule.displayName,
          state: schedule.state,
          cron: schedule.cron,
          ...(schedule.startedRunCount !== undefined ? { runsStarted: schedule.startedRunCount } : {}),
          ...(schedule.maxRunCount !== undefined ? { maxRunCount: schedule.maxRunCount } : {}),
          ...(schedule.endTime !== undefined ? { endTime: schedule.endTime } : {}),
        },
        deletes: "the schedule, so no new runs are created",
        keeps: "the runs it already started; deleting a schedule does not delete them",
      },
      payload: { schedule: schedule.name } as Readonly<Record<string, unknown>>,
      fingerprint: { schedule: schedule.name, state: schedule.state, cron: schedule.cron },
    }
  },

  async commit(plan, ctx) {
    const payload = payloadOf<{ schedule: string }>(plan)
    const fingerprint = plan.fingerprint as unknown as { schedule: string; state: string; cron: string }
    settingsFor(ctx, "a schedule delete plan")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, payload.schedule, ctx.call.signal)
    if (!schedule || schedule.state !== fingerprint.state || schedule.cron !== fingerprint.cron) throw new ColabError("PLAN_CHANGED", "The schedule changed or is gone since the preview.")
    await ctx.deps.vertex.deleteSchedule(ctx.account.alias, schedule.name, ctx.call.signal)
    return { schedule: schedule.name, id: lastSegment(schedule.name), deleted: true }
  },
}

export const PLAN_HANDLERS = {
  "schedule.create": { enterprise: scheduleCreate },
  "schedule.update": { enterprise: scheduleUpdate },
  "schedule.resume": { enterprise: scheduleResume },
  "schedule.delete": { enterprise: scheduleDelete },
} as const

export { scheduleCreate, scheduleUpdate, scheduleResume, scheduleDelete }
