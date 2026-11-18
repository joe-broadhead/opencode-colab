/**
 * The opt-in budgets (design §8.5): `accounts.<alias>.budget` holds `enterpriseUsdDaily`, `runtimeHoursDaily` and an
 * action (`warn` or `refuse`). Package E calls `check` at the preview and the commit of `job.create`,
 * `schedule.create` and `schedule.resume`, package D at `runtime.create`; on `refuse` the caller answers
 * `BUDGET_REACHED`, on `warn` it rides back as the `BUDGET_WARN` warning. Release, pause, stop and cancel never ask,
 * because they lower the cost.
 *
 * How spend is measured, exactly:
 *
 * - consumer runtime-hours come from the ledger: each record's `createdAt` up to `releasedAt` (or now), intersected
 *   with the person's local day. That figure is complete, so `runtimeHoursDaily` refuses as asked;
 * - Enterprise USD comes from the ledger's runs started today: each run's `estimatedUsd` (the preview's figure, stored
 *   by package E at the commit) or, for a record that names its machine, E's dated table. The day's counted spend plus
 *   the call's own estimate decides: within the limit → `ok`; over it → `refuse` or `warn`, as the budget's action
 *   says. A legacy record with neither figure is uncounted (`$0`), so the day is a floor: a call within the rest of the
 *   limit answers `ok` even though the real spend is higher, and `colab_status` says `complete: false`.
 *
 * Nothing here makes a Google call: the budget is local, so it answers before the first request of a change.
 */
import type { PortEnv } from "../deps.js"
import type { Budget, Prices } from "../ports.js"
import { consumerUsage, dayStart, enterpriseUsage } from "./usage.js"

/** The price table the budget prices a `spec`-named run with: E's dated table. */
const NO_PRICES: Pick<Prices, "usdPerHour"> = { usdPerHour: () => undefined }

export interface BudgetEnvironment {
  readonly options: PortEnv["options"]
  readonly ledger: PortEnv["ledger"]
  readonly clock: PortEnv["clock"]
  readonly prices?: Pick<Prices, "usdPerHour">
}

export function createBudget(env: BudgetEnvironment): Budget {
  const prices = env.prices ?? NO_PRICES
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
        return { verdict: configured.action === "refuse" ? "refuse" : "warn", spent, limit, unit: "runtime-hours" }
      }

      const limit = configured.enterpriseUsdDaily
      if (limit === undefined) return { verdict: "ok" }
      const usage = enterpriseUsage(runs, prices, from, now)
      const spent = usage.usd ?? 0
      const proposed = input.usd ?? 0
      if (spent + proposed <= limit + 1e-9) return { verdict: "ok" }
      return { verdict: configured.action === "refuse" ? "refuse" : "warn", spent, limit, unit: "usd" }
    },
  }
}
