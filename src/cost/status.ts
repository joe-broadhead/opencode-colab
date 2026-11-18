/**
 * `colab_status` (design §6, §8.4): the accounts, the runtimes (the plugin's own first), the runs and jobs in flight,
 * the `cost` and `cleanup` blocks, the automation state and the last errors. It is a read tool: it asserts
 * `colab.status` once through the wrapper, and `colab.read` once per provider operation through `ctx.providerRead`.
 *
 * What it shows about money, and what it will not pretend:
 *
 * - consumer runtime-hours today and running, by accelerator, with `ratesKnown: false`: Google publishes no compute-unit
 *   rate or balance (design §8.1, U1);
 * - Enterprise $/h for every running runtime, from the dated table, with the EUC and idle-shutdown flags;
 * - today's job estimate from the ledger, and whether it is complete: a run whose record does not name its compute is
 *   counted as unpriced rather than guessed at;
 * - `cleanup`: the biggest saving first, each one call — the `runtime.delete` plan for an idle runtime of ours, and a
 *   `runtime.stop` plan for an Enterprise runtime only with the design's warning in the entry itself (never an
 *   automatic suggestion to act without telling the person).
 *
 * A provider read that fails does not fail the whole status: it is caught when it is one of the plugin's own codes and
 * named in `lastErrors`; a host permission denial propagates, as everywhere.
 */
import type { ErrorCode, WarningCode } from "../domain/errors.js"
import { ColabError } from "../domain/errors.js"
import { OPERATIONS } from "../domain/actions.js"
import type { OutputOf } from "../domain/contract.js"
import type { ColabRuntime, RuntimeRecord, RuntimeSpecKey } from "../ports.js"
import type { HandlerContext } from "../tools/types.js"
import { ledgerBase, automationNote, automationOwner, automationState, type AutomationState } from "./automation.js"
import { readIdle, idleRuleOf, type IdleVerdict } from "./idle.js"
import { RELEASE_LOSS } from "./release.js"
import { consumerUsage, dayStart, enterpriseUsage, hours, usd } from "./usage.js"

/** One runtime row as the contract's `RuntimeView` takes it: the fields status fills, all our own words. */
type RuntimeRow = {
  readonly id: string
  readonly account: string
  readonly backend: "colab" | "enterprise"
  readonly spec: string
  readonly state: string
  readonly ours: boolean
  readonly tainted: boolean
  readonly createdAt?: string
  readonly idleSince?: string
  readonly lease?: { readonly releaseAfterIdleMinutes: number; readonly maxHours: number }
  readonly keep?: string[]
  readonly usdPerHour?: number
  readonly idleShutdownMinutes?: number | null
  readonly euc?: boolean
}

const specLabel = (spec: RuntimeSpecKey): string => (spec.accelerator === "NONE" ? "CPU" : `${spec.accelerator} ${spec.variant === "VARIANT_TPU" ? "TPU" : "GPU"}`)

/** A provider read the status makes: the plugin's own codes become a line in `lastErrors`, a denial propagates. */
async function attempt<T>(errors: string[], what: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (!ColabError.is(error)) throw error
    errors.push(`${error.code}: ${what}.`)
    return undefined
  }
}

/** The runtime's ledger view, with Jupyter's idle figure for a ready runtime of ours. */
async function runtimeView(ctx: HandlerContext, record: RuntimeRecord, now: Date, errors: string[], attention: string[]): Promise<{ readonly view: RuntimeRow; readonly idle?: Extract<IdleVerdict, { state: "idle" }> }> {
  const rule = idleRuleOf(record, { autoReleaseMinutes: ctx.deps.options.autoReleaseMinutes, maxHours: ctx.deps.options.maxRuntimeHours })
  const base = {
    id: record.id,
    account: record.account,
    backend: "colab" as const,
    spec: specLabel(record.spec),
    state: record.state,
    ours: true,
    tainted: record.tainted !== undefined,
    createdAt: record.createdAt,
    lease: { releaseAfterIdleMinutes: rule.autoReleaseMinutes, maxHours: rule.maxHours },
    keep: [...record.keep],
  }
  if (record.tainted) {
    attention.push(`Runtime ${record.id}: it is tainted, so it is released only by plan (colab_plan with runtime.delete).`)
    return { view: base }
  }
  if (record.state !== "ready") return { view: base }

  const runs = await attempt(errors, "the ledger's active runs could not be read", () => ctx.deps.ledger.listRuns({ account: record.account, state: "running" }))
  const activeRuns = (runs ?? []).filter((run) => run.runtime === record.id).length
  const verdict = await readIdle({
    record,
    kernels: async (account, runtimeId) => {
      await ctx.providerRead(OPERATIONS.kernelsList)
      return ctx.deps.runtime.kernels({ account, runtimeId }, ctx.call.signal)
    },
    sessions: async (account, runtimeId) => {
      await ctx.providerRead(OPERATIONS.sessionsList)
      return ctx.deps.runtime.sessions({ account, runtimeId }, ctx.call.signal)
    },
    get: async (account, runtimeId) => {
      await ctx.providerRead(OPERATIONS.runtimesGet)
      return ctx.deps.colab.getRuntime(account, runtimeId, ctx.call.signal)
    },
    activeRuns,
    rule,
    now,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (!ColabError.is(error)) throw error
    errors.push(`${error.code}: runtime ${record.id}'s Jupyter state could not be read.`)
    return { state: "blocked", why: "unreadable" } as const
  })
  if (verdict.state === "idle") return { view: { ...base, idleSince: verdict.lastActivity }, idle: verdict }
  if (verdict.state === "blocked" && verdict.why === "unreadable") {
    attention.push(`Runtime ${record.id}: its state could not be read (${("code" in verdict ? verdict.code : undefined) ?? "unreadable"}), so it was left alone.`)
  }
  if (verdict.state === "gone") attention.push(`Runtime ${record.id}: it has ended, so its ledger record will be closed.`)
  return { view: base }
}

export async function runStatus(_input: unknown, ctx: HandlerContext): Promise<OutputOf<"status">> {
  const deps = ctx.deps
  const options = deps.options
  const account = ctx.account
  const alias = account.alias
  const now = deps.clock.now()
  const errors: string[] = []
  const warnings = new Set<WarningCode>()

  const scopes = await deps.auth.scopes(alias)
  const signedIn = scopes.length > 0
  let tier: string | undefined
  if (account.backend === "colab" && signedIn) {
    tier = await attempt(errors, "Colab's subscription tier could not be read", async () => {
      await ctx.providerRead(OPERATIONS.subscriptionGet)
      return deps.colab.getSubscription(alias, ctx.call.signal)
    })
  }

  // ── Consumer runtimes: the plugin's own first, then the ones Google lists for the person ──
  const ownRecords = await deps.ledger.listRuntimes({ account: alias })
  const live = ownRecords.filter((record) => record.state === "ready" || record.state === "creating")
  const own: RuntimeRow[] = []
  const idle: { readonly record: RuntimeRecord; readonly verdict: Extract<IdleVerdict, { state: "idle" }> }[] = []
  const attention: string[] = []
  for (const record of live) {
    const read = await runtimeView(ctx, record, now, errors, attention)
    own.push(read.view)
    if (read.idle) idle.push({ record, verdict: read.idle })
  }
  const known = new Set(ownRecords.map((record) => record.id))
  // An Enterprise account has no consumer tier, runtime list or kernels: its reads are the Enterprise ones below.
  const listed = account.backend !== "colab" ? undefined : await attempt(errors, "Colab's runtime list could not be read", async () => {
    await ctx.providerRead(OPERATIONS.runtimesList)
    return deps.colab.listRuntimes(alias, ctx.call.signal)
  })
  const others: RuntimeRow[] = (listed ?? [])
    .filter((runtime: ColabRuntime) => !known.has(lastSegment(runtime.name)))
    .map((runtime) => ({
      id: lastSegment(runtime.name),
      account: alias,
      backend: "colab" as const,
      spec: specLabel(runtime.spec),
      // Colab's runtime list does not hand the plugin a state, so this is our word for "Google lists it as assigned
      // to you", not an invented Google enum value.
      state: "assigned",
      ours: false,
      tainted: false,
    }))
  const runtimes: RuntimeRow[] = [...own, ...others]

  // ── Enterprise runtimes: listed, priced, flagged, and never stopped without the plan warning ──
  const enterprise: RuntimeRow[] = []
  let enterpriseUsdPerHour: number | undefined
  const enterpriseRunning = await attempt(errors, "the Enterprise runtime list could not be read", async () => {
    await ctx.providerRead(OPERATIONS.notebookRuntimesList)
    return deps.vertex.listRuntimes(alias, ctx.call.signal)
  })
  for (const runtime of enterpriseRunning ?? []) {
    const perHour = runtime.machineType !== undefined ? deps.prices.usdPerHour({ machine: runtime.machineType, ...(runtime.accelerator !== undefined ? { accelerator: runtime.accelerator } : {}), ...(account.region !== undefined ? { region: account.region } : {}) }) : undefined
    if (perHour !== undefined) enterpriseUsdPerHour = (enterpriseUsdPerHour ?? 0) + perHour
    if (runtime.euc) warnings.add("EUC_RUNTIME")
    if (runtime.idleShutdownMinutes === null) warnings.add("IDLE_SHUTDOWN_OFF")
    enterprise.push({
      id: runtime.name,
      account: alias,
      backend: "enterprise",
      spec: [runtime.machineType, runtime.accelerator].filter((part) => part !== undefined).join(" ") || "unknown",
      state: runtime.state,
      ours: false,
      tainted: false,
      ...(perHour !== undefined ? { usdPerHour: perHour } : {}),
      idleShutdownMinutes: runtime.idleShutdownMinutes ?? null,
      euc: runtime.euc ?? false,
    })
  }
  runtimes.push(...enterprise)

  // ── Runs in flight, and the last errors ──
  const allRuns = await deps.ledger.listRuns({ account: alias })
  const active = allRuns.filter((run) => run.state === "running")
  const lastErrors = [
    ...errors,
    ...allRuns
      .filter((run) => run.errorCode !== undefined)
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
      .slice(0, 3)
      .map((run) => `${run.errorCode as ErrorCode}: run ${run.runId}${run.backend === "enterprise" ? " (Enterprise job)" : ""}.`),
  ].slice(0, 3)

  // ── Cost ──
  const from = dayStart(now)
  const consumer = consumerUsage(ownRecords, now, from)
  const enterpriseToday = enterpriseUsage(allRuns, deps.prices, from, now)
  if (consumer.running > 0) warnings.add("RATES_UNKNOWN")
  if (tier === "SUBSCRIPTION_TIER_FREE") warnings.add("FREE_TIER_PRIORITY")
  const budget = account.budget
  const budgetRow =
    budget === undefined
      ? undefined
      : {
          ...(budget.enterpriseUsdDaily !== undefined ? { enterpriseUsdDaily: budget.enterpriseUsdDaily } : {}),
          ...(budget.runtimeHoursDaily !== undefined ? { runtimeHoursDaily: budget.runtimeHoursDaily } : {}),
          action: budget.action,
          spentUsd: money(enterpriseToday.usd ?? 0),
          spentRuntimeHours: consumer.runtimeHours,
          complete: enterpriseToday.unpriced === 0,
        }
  if (budgetRow !== undefined && budgetRow.complete && ((budgetRow.enterpriseUsdDaily !== undefined && budgetRow.spentUsd >= budgetRow.enterpriseUsdDaily) || (budgetRow.runtimeHoursDaily !== undefined && budgetRow.spentRuntimeHours >= budgetRow.runtimeHoursDaily))) {
    warnings.add("BUDGET_WARN")
  }

  const owner = automationOwner(ledgerBase(deps.ledger), () => now.getTime())
  const automation: AutomationState = automationState({ automation: options.automation, access: options.access, owner: owner.owner })
  const cost = {
    currency: "USD",
    consumer: {
      runtimeHoursToday: round(consumer.runtimeHours),
      running: consumer.running,
      oldestHours: round(consumer.oldestHours),
      byAccelerator: byAccelerator(ownRecords),
      ratesKnown: false,
    },
    enterprise: {
      running: (enterpriseRunning ?? []).length,
      ...(enterpriseUsdPerHour !== undefined ? { usdPerHour: money(enterpriseUsdPerHour) } : {}),
      jobsToday: {
        runs: enterpriseToday.runs,
        runningJobs: active.filter((run) => run.backend === "enterprise").length,
        ...(enterpriseToday.usd !== undefined ? { usd: money(enterpriseToday.usd) } : {}),
        complete: enterpriseToday.unpriced === 0,
        unpriced: enterpriseToday.unpriced,
      },
    },
    ...(budgetRow !== undefined ? { budget: budgetRow } : { budget: "none" }),
    automation,
    automationNote: automationNote(automation),
    ...(owner.holder !== undefined ? { automationHolder: owner.holder } : {}),
    ...(idle.length > 0 ? { releasable: idle.length } : {}),
    ...(attention.length > 0 ? { attention } : {}),
  }

  // ── Cleanup: biggest saving first, each one call ──
  const cleanup: { saving: string; call: string; rank: number }[] = idle.map(({ record, verdict }) => ({
    saving: `${specLabel(record.spec)} idle ${Math.round(verdict.idleMinutes)} min; releasing it ends ${hours(consumerAgeHours(record, now))} of today's runtime-hours. ${RELEASE_LOSS}`,
    call: `colab_plan({ action: "runtime.delete", params: { runtime: "${record.id}" } })`,
    // Priced savings rank first: consumer compute-unit rates are not published, so its hours cannot be compared with
    // a dollar figure (design §8.1).
    rank: consumerAgeHours(record, now),
  }))
  for (const runtime of enterpriseRunning ?? []) {
    if (runtime.machineType === undefined) continue
    const perHour = deps.prices.usdPerHour({ machine: runtime.machineType, ...(runtime.accelerator !== undefined ? { accelerator: runtime.accelerator } : {}), ...(account.region !== undefined ? { region: account.region } : {}) })
    if (perHour === undefined) continue
    cleanup.push({
      saving: `${usd(perHour)}/h. ${STOP_WARNING}`,
      call: `colab_plan({ action: "runtime.stop", params: { runtime: "${runtime.name}" } })`,
      rank: 1_000_000 + perHour,
    })
  }
  cleanup.sort((a, b) => b.rank - a.rank)

  return {
    state: "ok",
    accounts: [
      {
        alias,
        backend: account.backend,
        signedIn,
        scopes: [...scopes],
        ...(tier !== undefined ? { tier } : {}),
        ...(account.project !== undefined ? { project: account.project } : {}),
        ...(account.region !== undefined ? { region: account.region } : {}),
      },
    ],
    runtimes,
    runs: active.map((run) => ({ runId: run.runId, state: run.state, ...(run.runtime !== undefined ? { runtime: run.runtime } : {}), ...(run.job !== undefined ? { job: run.job } : {}) })),
    cost,
    cleanup: cleanup.map(({ saving, call }) => ({ saving, call })),
    automation,
    lastErrors,
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
  }
}

/** The design's §7.2 wording, word for word, whenever a stop is offered (design §8.4). */
export const STOP_WARNING = "kernel state and running cells are lost; the disk is kept and still billed; the person may be using this runtime — there is no idle signal"

const lastSegment = (name: string): string => name.split("/").at(-1) ?? name
/** Runtime-hours to one decimal; a USD figure to the cent, so $0.19 does not print as $0.20. */
const round = (value: number): number => Math.round(value * 10) / 10
const money = (value: number): number => Math.round(value * 100) / 100

function consumerAgeHours(record: RuntimeRecord, now: Date): number {
  const created = Date.parse(record.createdAt)
  return Number.isFinite(created) ? Math.max(0, (now.getTime() - created) / 3_600_000) : 0
}

function byAccelerator(records: readonly RuntimeRecord[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const record of records) {
    if (record.state !== "ready" && record.state !== "creating") continue
    const key = record.spec.accelerator === "NONE" ? "CPU" : record.spec.accelerator
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

/** The cost summary `/colab-status` and the TUI show without a Google call (design §8.4, §14). */
export interface LedgerCostSummary {
  readonly runtimeHoursToday: number
  readonly runtimesRunning: number
  readonly noRunActive: number
  readonly usdToday?: number
  readonly complete: boolean
  readonly topCleanup?: string
}

/**
 * The ledger-only part of the cost block: what `/colab-status`, the TUI row and the budget share. No Jupyter read, no
 * Google call, so it can run on every status refresh; the full block, with idle state and Enterprise $/h, is
 * `colab_status`.
 */
export function ledgerCostSummary(input: {
  readonly runtimes: readonly RuntimeRecord[]
  readonly runs: readonly import("../ports.js").RunRecord[]
  readonly now: Date
  readonly prices?: { usdPerHour(input: { machine: string; accelerator?: string; acceleratorCount?: number; region?: string }): number | undefined }
}): LedgerCostSummary {
  const from = dayStart(input.now)
  const consumer = consumerUsage(input.runtimes, input.now, from)
  const active = new Set(input.runs.filter((run) => run.state === "running" && run.runtime !== undefined).map((run) => run.runtime as string))
  const enterprise = input.prices === undefined ? undefined : enterpriseUsage(input.runs, input.prices, from, input.now)
  const quiet = input.runtimes.filter((record) => (record.state === "ready" || record.state === "creating") && !active.has(record.id))
  const oldest = quiet
    .map((record) => ({ record, hours: (input.now.getTime() - Date.parse(record.createdAt)) / 3_600_000 }))
    .filter((entry) => Number.isFinite(entry.hours))
    .sort((a, b) => b.hours - a.hours)[0]
  return {
    runtimeHoursToday: round(consumer.runtimeHours),
    runtimesRunning: consumer.running,
    noRunActive: quiet.length,
    ...(enterprise?.usd !== undefined ? { usdToday: money(enterprise.usd) } : {}),
    complete: enterprise === undefined ? false : enterprise.unpriced === 0,
    ...(oldest !== undefined ? { topCleanup: `colab_plan({ action: "runtime.delete", params: { runtime: "${oldest.record.id}" } })` } : {}),
  }
}
