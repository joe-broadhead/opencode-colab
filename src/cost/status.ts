/**
 * `colab_status` (design §6, §8.4): the accounts, the runtimes (the plugin's own first), the runs in flight, the `cost`
 * and `cleanup` blocks, the automation state and the last errors. A read tool: the wrapper asserts `colab.status` once,
 * and each provider read asserts `colab.read` through `ctx.providerRead`.
 *
 * Money, as far as it is known: consumer cost in runtime-hours (`ratesKnown: false`, because no documented API
 * publishes a compute-unit rate or balance), Enterprise $/h from the dated table, and today's job estimate from the
 * ledger with `complete: false` when a record does not name its compute. `cleanup` is one call per entry, biggest
 * saving first, and an Enterprise stop always carries §7.2's warning.
 */
import type { ErrorCode, WarningCode } from "../domain/errors.js"
import { ColabError } from "../domain/errors.js"
import { OPERATIONS } from "../domain/actions.js"
import type { OutputOf } from "../domain/contract.js"
import type { ColabRuntime, RuntimeRecord, RuntimeSpecKey } from "../ports.js"
import type { HandlerContext } from "../tools/types.js"
import { automationOwner, automationState, ledgerBase, type AutomationState } from "./automation.js"
import { readIdle, type IdleVerdict } from "./idle.js"
import { RELEASE_LOSS } from "./release.js"
import { consumerUsage, dayStart, enterpriseUsage, hours, usd } from "./usage.js"

/** The design's §7.2 wording, word for word, whenever a stop is offered (design §8.4). */
export const STOP_WARNING = "kernel state and running cells are lost; the disk is kept and still billed; the person may be using this runtime — there is no idle signal"

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
const last = (name: string): string => name.split("/").at(-1) ?? name
const round = (value: number): number => Math.round(value * 10) / 10
/** Runtime-hours to one decimal; USD to the cent, so $0.19 does not print as $0.20. */
const money = (value: number): number => Math.round(value * 100) / 100
const ageHours = (record: RuntimeRecord, now: Date): number => Math.max(0, (now.getTime() - Date.parse(record.createdAt)) / 3_600_000)

export async function runStatus(_input: unknown, ctx: HandlerContext): Promise<OutputOf<"status">> {
  const deps = ctx.deps
  const { alias, backend, region, budget, project } = ctx.account
  const now = deps.clock.now()
  const errors: string[] = []
  const warnings = new Set<WarningCode>()
  const attention: string[] = []

  /** A provider read: the plugin's own codes become a line in `lastErrors`; a host denial propagates. */
  const attempt = async <T>(what: string, read: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await read()
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError" || !ColabError.is(error)) throw error
      errors.push(`${error.code}: ${what}.`)
      return undefined
    }
  }

  const scopes = await deps.auth.scopes(alias)
  const signedIn = scopes.length > 0
  const tier =
    backend === "colab" && signedIn
      ? await attempt("tier", async () => {
          await ctx.providerRead(OPERATIONS.subscriptionGet)
          return deps.colab.getSubscription(alias, ctx.call.signal)
        })
      : undefined

  // ── Consumer runtimes: the plugin's own first, then the ones Colab lists for the person ──
  const records = await deps.ledger.listRuntimes({ account: alias })
  const runtimes: RuntimeRow[] = []
  const idle: { readonly record: RuntimeRecord; readonly verdict: Extract<IdleVerdict, { state: "idle" }> }[] = []
  for (const record of records.filter((entry) => entry.state === "ready" || entry.state === "creating")) {
    const rule = { autoReleaseMinutes: record.lease?.releaseAfterIdleMinutes ?? deps.options.autoReleaseMinutes, maxHours: record.lease?.maxHours ?? deps.options.maxRuntimeHours }
    let row: RuntimeRow = { id: record.id, account: alias, backend: "colab", spec: specLabel(record.spec), state: record.state, ours: true, tainted: record.tainted !== undefined, createdAt: record.createdAt, lease: { releaseAfterIdleMinutes: rule.autoReleaseMinutes, maxHours: rule.maxHours }, keep: [...record.keep] }
    runtimes.push(row)
    if (record.tainted) {
      attention.push(`Runtime ${record.id}: tainted, so it is released only by plan.`)
      continue
    }
    if (record.state !== "ready") continue
    const runs = await deps.ledger.listRuns({ account: alias, state: "running" }).catch((error: unknown) => {
      if (!ColabError.is(error)) throw error
      errors.push(`${error.code}: runs.`)
      return undefined
    })
    if (runs === undefined) {
      // Without the ledger's run list nothing may be called idle: a live run would otherwise look like an idle runtime.
      attention.push(`Runtime ${record.id}: its runs could not be read, so it was left alone.`)
      continue
    }
    const verdict = await readIdle({
      record,
      kernels: async (account, runtimeId) => {
        await ctx.providerRead(OPERATIONS.kernelsList)
        return deps.runtime.kernels({ account, runtimeId }, ctx.call.signal)
      },
      sessions: async (account, runtimeId) => {
        await ctx.providerRead(OPERATIONS.sessionsList)
        return deps.runtime.sessions({ account, runtimeId }, ctx.call.signal)
      },
      get: async (account, runtimeId) => {
        await ctx.providerRead(OPERATIONS.runtimesGet)
        return deps.colab.getRuntime(account, runtimeId, ctx.call.signal)
      },
      activeRuns: runs.filter((run) => run.runtime === record.id).length,
      rule,
      now,
    }).catch((error: unknown) => {
      if (!ColabError.is(error)) throw error
      errors.push(`${error.code}: runtime ${record.id}.`)
      return { state: "blocked", why: "unreadable" } as const
    })
    if (verdict.state === "idle") {
      row = { ...row, idleSince: verdict.lastActivity }
      runtimes[runtimes.length - 1] = row
      idle.push({ record, verdict })
    } else if (verdict.state === "blocked" && verdict.why === "unreadable") {
      attention.push(`Runtime ${record.id}: ${"code" in verdict && verdict.code === "RUNTIME_BUSY" ? "another OpenCode process holds it" : "unreadable"}; left alone.`)
    }
  }
  const known = new Set(records.map((record) => record.id))
  const listed =
    backend === "colab"
      ? await attempt("runtime list", async () => {
          await ctx.providerRead(OPERATIONS.runtimesList)
          return deps.colab.listRuntimes(alias, ctx.call.signal)
        })
      : undefined
  for (const runtime of (listed ?? []) as readonly ColabRuntime[]) {
    // Colab's list gives no state; "assigned" is our word for what Google lists, not a Google enum value.
    if (!known.has(last(runtime.name))) runtimes.push({ id: last(runtime.name), account: alias, backend: "colab", spec: specLabel(runtime.spec), state: "assigned", ours: false, tainted: false })
  }

  // ── Enterprise runtimes: priced, flagged, and never stopped around the person's back ──
  const enterprise = await attempt("Enterprise runtimes", async () => {
    await ctx.providerRead(OPERATIONS.notebookRuntimesList)
    return deps.vertex.listRuntimes(alias, ctx.call.signal)
  })
  const priced = (enterprise ?? []).map((runtime) => ({
    runtime,
    perHour: runtime.machineType === undefined ? undefined : deps.prices.usdPerHour({ machine: runtime.machineType, ...(runtime.accelerator !== undefined ? { accelerator: runtime.accelerator } : {}), ...(region !== undefined ? { region } : {}) }),
  }))
  for (const { runtime, perHour } of priced) {
    if (runtime.euc) warnings.add("EUC_RUNTIME")
    if (runtime.idleShutdownMinutes === null) warnings.add("IDLE_SHUTDOWN_OFF")
    runtimes.push({
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

  // ── Runs in flight, the last errors, the cost ──
  const allRuns = await deps.ledger.listRuns({ account: alias })
  const active = allRuns.filter((run) => run.state === "running")
  const lastErrors = [
    ...errors,
    ...allRuns
      .filter((run) => run.errorCode !== undefined)
      .sort((a, b) => (b.endedAt ?? b.startedAt).localeCompare(a.endedAt ?? a.startedAt))
      .slice(0, 3)
      .map((run) => `${run.errorCode as ErrorCode}: run ${run.runId}.`),
  ].slice(0, 3)

  const from = dayStart(now)
  const consumer = consumerUsage(records, now, from)
  const today = enterpriseUsage(allRuns, deps.prices, from, now)
  if (consumer.running > 0) warnings.add("RATES_UNKNOWN")
  if (tier === "SUBSCRIPTION_TIER_FREE") warnings.add("FREE_TIER_PRIORITY")
  const budgetRow =
    budget === undefined
      ? undefined
      : {
          ...(budget.enterpriseUsdDaily !== undefined ? { enterpriseUsdDaily: budget.enterpriseUsdDaily } : {}),
          ...(budget.runtimeHoursDaily !== undefined ? { runtimeHoursDaily: budget.runtimeHoursDaily } : {}),
          action: budget.action,
          spentUsd: money(today.usd ?? 0),
          complete: today.unpriced === 0,
        }
  if (budgetRow?.action === "warn" && budgetRow.complete && ((budgetRow.enterpriseUsdDaily !== undefined && budgetRow.spentUsd >= budgetRow.enterpriseUsdDaily) || (budgetRow.runtimeHoursDaily !== undefined && consumer.runtimeHours >= budgetRow.runtimeHoursDaily))) {
    warnings.add("BUDGET_WARN")
  }

  const automation: AutomationState = automationState({ automation: deps.options.automation, access: deps.options.access, owner: automationOwner(ledgerBase(deps.ledger), () => now.getTime()).owner })
  const known2 = (enterprise ?? []).length
  const cost = {
    currency: "USD",
    consumer: { runtimeHoursToday: round(consumer.runtimeHours), running: consumer.running, ratesKnown: false },
    enterprise: {
      running: known2,
      ...(priced.some((entry) => entry.perHour !== undefined) ? { usdPerHour: money(priced.reduce((sum, entry) => sum + (entry.perHour ?? 0), 0)) } : {}),
      jobsToday: { runs: today.runs, ...(today.usd !== undefined ? { usd: money(today.usd) } : {}), complete: today.unpriced === 0 },
    },
    ...(budgetRow !== undefined ? { budget: budgetRow } : {}),
    automation,
    ...(attention.length > 0 ? { attention } : {}),
  }

  // ── Cleanup: biggest saving first, each one call ──
  const cleanup = [
    ...idle.map(({ record, verdict }) => ({
      saving: `${specLabel(record.spec)} idle ${Math.round(verdict.idleMinutes)} min, ${hours(ageHours(record, now))} today. ${RELEASE_LOSS}`,
      call: `colab_plan({ action: "runtime.delete", params: { runtime: "${record.id}" } })`,
      rank: ageHours(record, now),
    })),
    ...priced.flatMap(({ runtime, perHour }) => (perHour === undefined ? [] : [{ saving: `${usd(perHour)}/h. ${STOP_WARNING}`, call: `colab_plan({ action: "runtime.stop", params: { runtime: "${runtime.name}" } })`, rank: 1_000_000 + perHour }])),
  ].sort((a, b) => b.rank - a.rank)

  return {
    state: "ok",
    accounts: [{ alias, backend, signedIn, scopes: [...scopes], ...(tier !== undefined ? { tier } : {}), ...(project !== undefined ? { project } : {}), ...(region !== undefined ? { region } : {}) }],
    runtimes,
    runs: active.map((run) => ({ runId: run.runId, state: run.state, ...(run.runtime !== undefined ? { runtime: run.runtime } : {}), ...(run.job !== undefined ? { job: run.job } : {}) })),
    cost,
    cleanup: cleanup.map(({ saving, call }) => ({ saving, call })),
    automation,
    lastErrors,
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
  }
}
