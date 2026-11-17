/**
 * `colab_plan` → `colab_write` / `colab_delete` (design §6, §7.2), Day 0's own handlers. colab_plan looks the action
 * up in PLAN_ACTIONS, refuses the actions the plugin never plans, checks the action's params, calls the owning
 * package's preview for the account's backend, and stores a single-use plan bound to the session, agent and account.
 * A commit checks the binding, asserts `colab.<category>` on `<account>:<operation>` (write offers Always for that
 * resource; delete never does), takes the plan, and calls the same package's commit, which re-reads the target and
 * answers PLAN_CHANGED when it moved. A failed commit spends the plan.
 */
import { type Backend, COMMIT_TOOL, PLAN_ACTIONS, type PlanAction, type PlanCategory, REFUSED_PLAN_ACTIONS } from "../domain/actions.js"
import { CommitInput, PLAN_PARAMS, PlanInput } from "../domain/contract.js"
import { ColabError, type ErrorCode } from "../domain/errors.js"
import type * as z from "zod"
import { resolveAccount } from "../options.js"
import { handlerContext, parse, request, type Runner } from "../tools/spec.js"
import type { CallContext, HandlerContext, PlanHandler, PlanHandlers, ToolCall, ToolHandler } from "../tools/types.js"

const isPlanAction = (action: string): action is PlanAction => Object.hasOwn(PLAN_ACTIONS, action)

/** The handler for one action on one backend, or the code that refuses it. */
export function planHandler(handlers: PlanHandlers, action: string, backend: Backend): PlanHandler<PlanAction> {
  const refused = (REFUSED_PLAN_ACTIONS as Readonly<Record<string, ErrorCode>>)[action]
  if (refused) throw new ColabError(refused, `The plugin never plans ${action}.`)
  if (!isPlanAction(action)) throw new ColabError("ACTION_UNSUPPORTED", `There is no plan action ${action}.`, { next: `Use one of: ${Object.keys(PLAN_ACTIONS).join(", ")}.` })
  if (!(PLAN_ACTIONS[action].backends as Partial<Record<Backend, unknown>>)[backend]) {
    const next = action === "runtime.create" && backend === "enterprise" ? 'Plan colab_plan({ action: "job.create", params: { notebook } }) instead: Enterprise runs whole notebooks as jobs.' : `Use an account whose backend has ${action}.`
    throw new ColabError("ACTION_UNSUPPORTED", `${action} is not available on ${backend} accounts in v0.1.0.`, { next })
  }
  const handler = handlers[action]?.[backend] as PlanHandler<PlanAction> | undefined
  if (!handler) throw new ColabError("NOT_IMPLEMENTED", `The ${action} plan on ${backend} accounts is declared but not built in this pre-release.`)
  return handler
}

/** colab_plan: previews, stores and returns `{ planId, category, commit, expiresAt, preview }`. Writes nothing. */
export function planTool(handlers: PlanHandlers): ToolHandler<"plan"> {
  return {
    async run(input: z.output<typeof PlanInput>, ctx: HandlerContext) {
      const handler = planHandler(handlers, input.action, ctx.account.backend)
      const action = input.action as PlanAction
      const params = parse(PLAN_PARAMS[action], input.params ?? {})
      const entry = (PLAN_ACTIONS[action].backends as Partial<Record<Backend, { operation: string }>>)[ctx.account.backend]!
      const previewed = await handler.preview(params as never, ctx)
      const category: PlanCategory = PLAN_ACTIONS[action].category
      const plan = ctx.deps.plans.create({
        action,
        category,
        account: ctx.account.alias,
        backend: ctx.account.backend,
        operation: entry.operation as never,
        sessionId: ctx.call.sessionID,
        agentId: ctx.call.agent,
        preview: previewed.preview,
        payload: previewed.payload,
        fingerprint: previewed.fingerprint,
      })
      return {
        state: "ok" as const,
        planId: plan.id,
        action,
        category,
        commit: `colab_${COMMIT_TOOL[category]}` as "colab_write" | "colab_delete",
        expiresAt: new Date(plan.expiresAt).toISOString(),
        preview: plan.preview,
        ...(previewed.warnings?.length ? { warnings: [...previewed.warnings] } : {}),
      }
    },
  }
}

/**
 * colab_write / colab_delete: commit one plan. The commit's own ask is the only one; its metadata is the plan's
 * preview, which the plan already screened.
 */
export function commitTool(category: PlanCategory, handlers: PlanHandlers, runner: () => Runner): ToolHandler<"write"> {
  return {
    async run(input: z.output<typeof CommitInput>, base: CallContext) {
      const call: ToolCall = base.call
      const binding = { sessionId: call.sessionID, agentId: call.agent, category }
      const store = base.deps.plans
      const plan = store.check(input.planId, binding)
      const account = resolveAccount(base.deps.options, plan.account)
      const ctx = handlerContext(runner(), call, account)
      const handler = planHandler(handlers, plan.action, plan.backend)
      const resource = `${plan.account}:${plan.operation}`
      const metadata = { planId: plan.id, action: plan.action, category, account: plan.account, operation: plan.operation, preview: plan.preview }
      await runner().assert(request(call, `colab.${category}`, [resource], metadata, category === "write"))
      store.acquire(plan.id, binding)
      try {
        const result = await handler.commit(plan, ctx)
        store.complete(plan.id)
        return { state: "ok" as const, planId: plan.id, action: plan.action, result }
      } catch (error) {
        store.release(plan.id)
        throw error
      }
    },
  }
}
