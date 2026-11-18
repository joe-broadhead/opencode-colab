/**
 * What the plugin can say about money without a Google call (design §8.1, §8.4, §8.5).
 *
 * Google publishes no consumer compute-unit rate and no balance (design §8.1, U1), so consumer cost is counted in
 * runtime-hours, by accelerator, and says `ratesKnown: false`. Enterprise cost is USD from the dated price table
 * (package E's `Prices` seam); a job's estimate needs the compute it ran on, which the ledger holds when the record
 * carries `estimatedUsd` or `spec` (the machine) — otherwise the figure is incomplete and says so.
 *
 * Everything here reads the ledger and options only: no network, no token.
 */
import type { Ledger, Prices, RunRecord, RuntimeRecord } from "../ports.js"

/** One record's share of a time window, in hours; a released record stops at its release. */
export function runtimeHoursBetween(record: Pick<RuntimeRecord, "createdAt" | "releasedAt">, from: Date, to: Date): number {
  const created = Date.parse(record.createdAt)
  if (!Number.isFinite(created)) return 0
  const released = record.releasedAt ? Date.parse(record.releasedAt) : to.getTime()
  const start = Math.max(created, from.getTime())
  const end = Math.min(Number.isFinite(released) ? released : to.getTime(), to.getTime())
  return end > start ? (end - start) / 3_600_000 : 0
}

/** The start of the person's local day: "today" in the cost block and the budget's daily window. */
export function dayStart(now: Date): Date {
  const start = new Date(now.getTime())
  start.setHours(0, 0, 0, 0)
  return start
}

/**
 * A run's USD estimate: the record's own `estimatedUsd` when a package recorded one, else the machine its `spec` names
 * at the dated table's rate for the run's length. `undefined` means the ledger does not say what it cost.
 */
export function runUsd(run: RunRecord, prices: Pick<Prices, "usdPerHour">, now: Date): number | undefined {
  const own = (run as { readonly estimatedUsd?: unknown }).estimatedUsd
  if (typeof own === "number") return Number.isFinite(own) && own >= 0 ? own : undefined
  if (run.spec === undefined) return undefined
  const perHour = prices.usdPerHour({ machine: run.spec })
  if (perHour === undefined) return undefined
  const started = Date.parse(run.startedAt)
  if (!Number.isFinite(started)) return undefined
  const ended = run.endedAt ? Date.parse(run.endedAt) : now.getTime()
  return perHour * Math.max(0, ((Number.isFinite(ended) ? ended : now.getTime()) - started) / 3_600_000)
}

export interface ConsumerUsage {
  /** Runtime-hours of the plugin's own consumer runtimes inside the window. */
  readonly runtimeHours: number
  /** Consumer runtimes of ours that are live now (ready or creating), tainted ones included: they still bill. */
  readonly running: number
}

export function consumerUsage(runtimes: readonly RuntimeRecord[], now: Date, from: Date): ConsumerUsage {
  return {
    runtimeHours: runtimes.reduce((sum, record) => sum + runtimeHoursBetween(record, from, now), 0),
    running: runtimes.filter((record) => record.state === "ready" || record.state === "creating").length,
  }
}

export interface EnterpriseUsage {
  /** Enterprise runs started in the window. */
  readonly runs: number
  /** The priced part of their cost; undefined when none could be priced. */
  readonly usd?: number
  /** Runs in the window whose compute the ledger does not name, so `usd` is a floor, not the total. */
  readonly unpriced: number
}

export function enterpriseUsage(runs: readonly RunRecord[], prices: Pick<Prices, "usdPerHour">, from: Date, now: Date): EnterpriseUsage {
  const window = runs.filter((run) => run.backend === "enterprise" && run.startedAt >= from.toISOString())
  let usd: number | undefined
  let unpriced = 0
  for (const run of window) {
    const estimate = runUsd(run, prices, now)
    if (estimate === undefined) {
      unpriced += 1
      continue
    }
    usd = (usd ?? 0) + estimate
  }
  return { runs: window.length, ...(usd !== undefined ? { usd } : {}), unpriced }
}

/** The label every surface shows for a runtime's compute: "CPU", "T4 GPU", "v2-8 TPU". */
export const specLabel = (spec: { readonly accelerator: string; readonly variant: string }): string =>
  spec.accelerator === "NONE" ? "CPU" : `${spec.accelerator} ${spec.variant === "VARIANT_TPU" ? "TPU" : "GPU"}`

/** Runtime-hours as one decimal, the figure every surface shows. */
export const hours = (value: number): string => `${value.toFixed(1)} runtime-hour${Math.abs(value - 1) < 0.05 ? "" : "s"}`

/** USD with cents, as the cleanup entry shows it. */
export const usd = (value: number): string => `$${value.toFixed(2)}`
