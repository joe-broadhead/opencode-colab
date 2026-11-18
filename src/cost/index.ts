/**
 * Package F, Cost, cleanup, status (docs/v1-design.md, File ownership): `colab_status`, the one release function, the
 * opt-in budgets, the automation owner and the Jupyter idle rule, `/colab-cleanup`, and the three hooks. `src/status.ts`,
 * `src/rpc.ts` and `src/tui/` grow the same status for `/colab-status` and the dialog.
 *
 * The pieces and the design sections they build: §8.3 (automation, harvest-then-release), §8.4 (cost and cleanup
 * blocks, hooks), §8.5 (the person's command and budgets), §16 F.
 */
import type { Plugin } from "@opencode/plugin"
import type { Deps, PortEnv } from "../deps.js"
import type { Budget, Prices, Release } from "../ports.js"
import type { RuntimePorts } from "../runtime/index.js"
import type { ToolHandlers } from "../tools/types.js"
import { ledgerBase, createAutomationLoop, type AutomationLoop } from "./automation.js"
import { createBudget as budgetFrom } from "./budget.js"
import { registerCleanup } from "./cleanup.js"
import { registerHooks } from "./hooks.js"
import { createRelease } from "./release.js"
import { runStatus } from "./status.js"

export const HANDLERS: ToolHandlers = {
  status: { run: runStatus },
}

/** The one release function (design §8.3 step 2): harvest the keep paths, then `runtimes.delete`. */
export { createRelease }

/**
 * The opt-in budgets (design §8.5). `src/deps.ts` takes the factory by this name, so `deps.budget` is F's; `refuse`
 * becomes `BUDGET_REACHED` in the caller, `warn` the BUDGET_WARN warning.
 */
export function createBudget(env: PortEnv, prices: Prices): Budget {
  // The daily figure is each run's `estimatedUsd` (E stamps it at the job's commit); E's table prices a record that
  // names its machine instead.
  return budgetFrom({ options: env.options, ledger: env.ledger, clock: env.clock, prices })
}

export interface CostContext {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly session: Pick<Plugin.Context["session"], "hook" | "synthetic" | "context">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
}

/** The host registrations F owns: `/colab-cleanup`, the three hooks and the automation loop. */
export async function registerCost(ctx: CostContext, deps: Deps): Promise<{ dispose(): Promise<void>; readonly problems: readonly string[] }> {
  const stops: { dispose(): Promise<void> }[] = []
  let loop: AutomationLoop | undefined
  let problems: readonly string[] = []
  try {
    stops.push(
      await registerCleanup(ctx, {
        options: deps.options,
        ledger: deps.ledger,
        release: deps.release,
        clock: deps.clock,
      }),
    )
    const hooks = await registerHooks(ctx, { options: deps.options, ledger: deps.ledger, clock: deps.clock })
    stops.push(...hooks.stop)
    problems = hooks.problems
    // The ledger's own housekeeping (design §5: pruned after ledgerDays) belongs to the one automation owner, once per
    // process. A failed prune never fails setup.
    deps.ledger.prune(deps.clock.now()).catch(() => undefined)
    loop = createAutomationLoop({
      options: deps.options,
      ledger: deps.ledger,
      runtime: deps.runtime,
      colab: deps.colab,
      release: deps.release,
      clock: deps.clock,
      ...(ledgerBase(deps.ledger) !== undefined ? { lockDir: ledgerBase(deps.ledger)! } : {}),
    })
  } catch (error) {
    for (const stop of stops.splice(0).reverse()) await stop.dispose().catch(() => undefined)
    await loop?.dispose()
    throw error
  }
  return {
    // A host that refused a hook is named in status (design §8.4, boxd C.6); `plugin.ts` words each one.
    problems,
    async dispose() {
      await loop?.dispose()
      for (const stop of stops.splice(0).reverse()) await stop.dispose()
    },
  }
}
