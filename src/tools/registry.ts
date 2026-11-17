/**
 * The registry: every tool in design §6, its handler from the package that owns it (src/domain/actions.ts `owner`),
 * and every plan handler. Day 0 owns colab_plan, colab_write and colab_delete (src/plans/route.ts). A package edits
 * only its own module; this file never changes when a package lands. test/unit/registry.test.ts checks that each tool
 * has exactly one handler, in its owner's module, and that each plan action and backend has exactly one plan handler.
 */
import * as cost from "../cost/index.js"
import { type Owner, PLAN_ACTIONS, type PlanAction, TOOLS } from "../domain/actions.js"
import type { ToolName } from "../domain/contract.js"
import * as enterprise from "../enterprise/index.js"
import * as execution from "../execution/index.js"
import * as notebooks from "../notebooks/index.js"
import { commitTool, planTool } from "../plans/route.js"
import * as sources from "../sources/index.js"
import type { Runner } from "./spec.js"
import type { PlanHandler, PlanHandlers, ToolHandler, ToolHandlers } from "./types.js"

/** Each package's tool handlers, by owner. A and B own no tool. */
export const PACKAGE_HANDLERS: Readonly<Record<Exclude<Owner, "Day0">, ToolHandlers>> = {
  A: {},
  B: {},
  C: notebooks.HANDLERS,
  D: execution.HANDLERS,
  E: enterprise.HANDLERS,
  F: cost.HANDLERS,
  G: sources.HANDLERS,
}

/** Each package's plan handlers, by owner. */
export const PACKAGE_PLAN_HANDLERS: Readonly<Partial<Record<Owner, PlanHandlers>>> = {
  C: notebooks.PLAN_HANDLERS,
  D: execution.PLAN_HANDLERS,
  E: enterprise.PLAN_HANDLERS,
}

/** Every plan handler, merged: one per (action, backend), from the owner PLAN_ACTIONS names. */
export function mergedPlanHandlers(): PlanHandlers {
  const merged: Record<string, Record<string, PlanHandler<PlanAction>>> = {}
  for (const [action, entry] of Object.entries(PLAN_ACTIONS) as [PlanAction, (typeof PLAN_ACTIONS)[PlanAction]][]) {
    for (const [backend, handlerEntry] of Object.entries(entry.backends) as [string, { owner: Owner }][]) {
      const handler = PACKAGE_PLAN_HANDLERS[handlerEntry.owner]?.[action]?.[backend as "colab" | "enterprise"]
      if (handler) (merged[action] ??= {})[backend] = handler as PlanHandler<PlanAction>
    }
  }
  return merged as PlanHandlers
}

/** The handler for each tool: Day 0's own three, or the owning package's. */
export function toolHandlers(runner: () => Runner): Readonly<Record<ToolName, ToolHandler<ToolName>>> {
  const plans = mergedPlanHandlers()
  const day0: ToolHandlers = { plan: planTool(plans), write: commitTool("write", plans, runner), delete: commitTool("delete", plans, runner) as never }
  const handlers: Partial<Record<ToolName, ToolHandler<ToolName>>> = {}
  for (const tool of TOOLS) {
    const source = tool.owner === "Day0" ? day0 : PACKAGE_HANDLERS[tool.owner]
    const handler = source[tool.name as ToolName]
    if (!handler) throw new Error(`colab_${tool.name} has no handler in package ${tool.owner}`)
    handlers[tool.name as ToolName] = handler as ToolHandler<ToolName>
  }
  return handlers as Record<ToolName, ToolHandler<ToolName>>
}
