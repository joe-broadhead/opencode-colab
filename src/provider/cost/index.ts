/**
 * Cost, cleanup, status and the automation loop: the opt-in budgets, the one release function, the idle rule, and the
 * rich status `usage` and `/colab` read.
 */
import type { Deps, PortEnv } from "../index.js"
import type { Budget, Prices, Release } from "../ports.js"
import type { ToolHandlers } from "../types.js"
import { createAutomationLoop, ledgerBase } from "./automation.js"
import { createBudget as budgetFrom } from "./budget.js"
import { createRelease } from "./release.js"
import { runStatus } from "./status.js"

export const HANDLERS: ToolHandlers = {
  status: { run: runStatus },
}

/** The one release function: harvest the keep paths, then delete. */
export { createRelease }

/** The opt-in budgets. `refuse` becomes BUDGET_EXCEEDED in the caller, `warn` the BUDGET_WARN warning. */
export function createBudget(env: PortEnv, prices: Prices): Budget {
  return budgetFrom({ options: env.options, ledger: env.ledger, clock: env.clock, prices })
}

/** The automation loop: the plugin's only background work, disposed with the plugin. */
export function startAutomation(deps: Deps): { dispose(): Promise<void> } {
  deps.ledger.prune(deps.clock.now()).catch(() => undefined)
  const loop = createAutomationLoop({
    options: deps.options,
    ledger: deps.ledger,
    runtime: deps.runtime,
    colab: deps.colab,
    release: deps.release,
    clock: deps.clock,
    ...(ledgerBase(deps.ledger) !== undefined ? { lockDir: ledgerBase(deps.ledger)! } : {}),
  })
  return {
    async dispose() {
      await loop.dispose()
    },
  }
}
