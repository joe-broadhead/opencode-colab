/**
 * The opt-in budgets (design §8.5): `accounts.<alias>.budget` holds `enterpriseUsdDaily`, `runtimeHoursDaily` and an
 * action (`warn` or `refuse`). Package E calls `check` at the preview and the commit of `job.create`,
 * `schedule.create` and `schedule.resume`, package D at `runtime.create`; on `refuse` the caller answers
 * `BUDGET_REACHED`, on `warn` it rides back as the `BUDGET_WARN` warning. Release, pause, stop and cancel never ask,
 * because they lower the cost.
 *
 * How spend is measured, and the one honesty it needs:
 *
 * - consumer runtime-hours come from the ledger: each record's `createdAt` up to `releasedAt` (or now), intersected
 *   with the person's local day. That figure is complete, so `runtimeHoursDaily` refuses as asked;
 * - Enterprise USD comes from the ledger's runs started today. The ledger holds a run's compute only when the record
 *   carries `estimatedUsd` or `spec` (the machine); a record with neither cannot be priced, so the day's spend is a
 *   floor. Then `colab_status` reports it incomplete, and a `refuse` budget degrades to `warn` (the family's rule for a
 *   number nobody can measure: never block every call on it). A single call whose own estimate is over the limit still
 *   refuses, because the proposed amount is always counted.
 *
 * Nothing here makes a Google call: the budget is local, so it answers before the first request of a change.
 */
import type { PortEnv } from "../deps.js"
import type { Budget } from "../ports.js"
import { consumerUsage, dayStart, enterpriseUsage } from "./usage.js"

export interface BudgetEnvironment {
  readonly options: PortEnv["options"]
  readonly ledger: PortEnv["ledger"]
  readonly clock: PortEnv["clock"]
}

export function createBudget(env: BudgetEnvironment): Budget {
  return {
    async check(account, input) {
      const configured = env.options.accounts.find((entry) => entry.alias === account)?.budget
      if (configured === undefined) return { verdict: "ok" }
      const now = env.clock.now()
      const from = dayStart(now)
      const [runtimes, runs] = await Promise.all([env.ledger.listRuntimes({ account }), env.ledger.listRuns({ account })])

      if (input.action === "runtime.create") {
        const limit = configured.runtimeHoursDaily
        if (limit === undefined) return { verdict: "ok" }
        const spent = consumerUsage(runtimes, now, from).runtimeHours
        // A create starts a runtime whose lease is at most `maxRuntimeHours`, so that is the amount it proposes.
        const proposed = input.runtimeHours ?? env.options.maxRuntimeHours
        if (spent + proposed <= limit + 1e-9) return { verdict: "ok" }
        return { verdict: configured.action === "refuse" ? "refuse" : "warn", spentUsd: spent, limitUsd: limit }
      }

      const limit = configured.enterpriseUsdDaily
      if (limit === undefined) return { verdict: "ok" }
      const usage = enterpriseUsage(runs, from)
      const spent = usage.usd ?? 0
      const proposed = input.usd ?? 0
      if (spent + proposed <= limit + 1e-9) return { verdict: "ok" }
      // A day with runs the ledger cannot price is measured only as a floor: refuse degrades to warn rather than
      // blocking every call on a number nobody can see.
      const unmeasured = usage.unpriced > 0
      return { verdict: configured.action === "refuse" && !unmeasured ? "refuse" : "warn", spentUsd: spent, limitUsd: limit }
    },
  }
}
