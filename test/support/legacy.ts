/**
 * A test bridge for the provider suites written before the contract doors existed. It calls the same provider handlers
 * the plugin ships, with the provider's own errors and the old result shape, so a provider test asserts provider
 * behaviour. The contract-level wrapper (input/output checks, account resolution, permission gate, plan ids) is tested
 * by `test/unit/handlers.test.ts`, `test/unit/plans.test.ts` and the host test.
 */
import * as z from "zod"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { CONTRACTS, PLAN_PARAMS, type ToolName } from "../../src/domain/contract.js"
import { ColabError } from "../../src/domain/errors.js"
import { PLAN_ACTIONS, REFUSED_PLAN_ACTIONS, type Backend, type PlanAction } from "../../src/domain/actions.js"
import { accountsFor } from "../../src/accounts.js"
import { manifest, version } from "../../src/manifest.js"
import { resolveAccount, type ResolvedAccount } from "../../src/options.js"
import type { Deps } from "../../src/provider/index.js"
import * as cost from "../../src/provider/cost/index.js"
import * as enterprise from "../../src/provider/enterprise/index.js"
import * as execution from "../../src/provider/execution/index.js"
import * as notebooks from "../../src/provider/notebooks/index.js"
import type { PlanHandler, PlanHandlers } from "../../src/provider/types.js"
import type { ToolHandler } from "../../src/provider/types.js"
import { providerContext } from "../../src/handlers/context.js"

export interface PermissionRequest {
  readonly sessionID: string
  readonly agent: string
  readonly action: string
  readonly resources: readonly string[]
  readonly save?: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly source: { readonly type: "tool"; readonly messageID: string; readonly id: string }
}

/** Records every assert; `decide` throws to deny (default: allow everything). */
export class RecordingPermission {
  readonly requests: PermissionRequest[] = []
  decide: (request: PermissionRequest) => void = () => undefined
  readonly assert = async (request: PermissionRequest) => {
    this.requests.push(request)
    this.decide(request)
  }
  actions() {
    return this.requests.map((request) => request.action)
  }
  denyAll(message = "denied by the test's rules") {
    this.decide = () => {
      throw new Error(message)
    }
  }
}

export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export interface Runner {
  readonly deps: Deps
  readonly assert: (request: PermissionRequest) => Promise<void>
  readonly handler?: (name: string) => unknown
  readonly released?: () => Promise<boolean>
}

const PACKAGE_HANDLERS = {
  ...notebooks.HANDLERS,
  ...execution.HANDLERS,
  ...enterprise.HANDLERS,
} as Readonly<Record<string, ToolHandler<ToolName> | undefined>>

function mergedPlans(): PlanHandlers {
  const merged: Record<string, Record<string, PlanHandler<PlanAction>>> = {}
  for (const source of [notebooks.PLAN_HANDLERS, execution.PLAN_HANDLERS, enterprise.PLAN_HANDLERS]) {
    for (const [action, entry] of Object.entries(source) as [PlanAction, Partial<Record<Backend, PlanHandler<PlanAction>>>][]) {
      merged[action] ??= {}
      Object.assign(merged[action]!, entry)
    }
  }
  return merged as PlanHandlers
}
const PLAN_HANDLERS = mergedPlans()

const assertWritable = (account: ResolvedAccount): void => {
  if (account.access !== "read") return
  throw new ColabError("ACCOUNT_READ_ONLY", `The account "${account.alias}" has access read, so the plugin makes no change on it.`, { next: `Set accounts.${account.alias}.access to write and sign in again.` })
}

const WRITES = new Set(["edit", "run", "cancel", "upload", "download", "pause"])

/** The old wrapper's handler accessor; kept only for the shape of the provider test runners. */
export const toolHandlers = (_runner: () => Runner): Record<string, unknown> => ({})

const failure = (error: unknown): Readonly<Record<string, unknown>> | undefined => {
  if (ColabError.is(error)) {
    return {
      state: error.state,
      error: error.code,
      message: error.detail,
      next: error.next,
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
    }
  }
  return undefined
}

const callOf = (call: ToolCall, account: string): MethodCall =>
  ({
    sessionID: call.sessionID,
    agent: call.agent,
    messageID: call.messageID,
    id: call.id,
    signal: call.signal,
    progress: async () => undefined,
    account,
    bus: { emit: async () => ({ ok: true }) },
    access: { rules: [] },
    unguardedAgents: async () => [],
    door: "tool",
  }) as unknown as MethodCall

interface StoredPlan {
  used?: boolean
  failed?: boolean
  readonly preview: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly fingerprint: Readonly<Record<string, unknown>>
  readonly account: string
  readonly category: "write" | "delete"
  readonly action: PlanAction
  readonly operation: string
}

const plans = new Map<string, StoredPlan>()
let nextPlan = 1
const PLAN_TTL_MS = 15 * 60_000

/** The provider plan for one action on one backend, with the old refusal codes. */
function providerPlan(action: string, backend: Backend): PlanHandler<PlanAction> {
  const refused = (REFUSED_PLAN_ACTIONS as Readonly<Record<string, string>>)[action]
  if (refused !== undefined) throw new ColabError(refused as never, `The plugin never plans ${action}.`)
  if (!Object.hasOwn(PLAN_ACTIONS, action)) throw new ColabError("ACTION_UNSUPPORTED", `There is no plan action ${action}.`, { next: `Use one of: ${Object.keys(PLAN_ACTIONS).join(", ")}.` })
  const item = PLAN_ACTIONS[action as PlanAction]
  if (!(item.backends as Partial<Record<Backend, unknown>>)[backend]) {
    const next = action === "runtime.create" && backend === "enterprise" ? 'Plan job.create with a notebook instead: Enterprise runs whole notebooks as jobs.' : `Use an account whose backend has ${action}.`
    throw new ColabError("ACTION_UNSUPPORTED", `${action} is not available on ${backend} accounts in this build.`, { next })
  }
  const handler = PLAN_HANDLERS[action as PlanAction]?.[backend] as PlanHandler<PlanAction> | undefined
  if (handler === undefined) throw new ColabError("NOT_IMPLEMENTED", `The ${action} plan on ${backend} accounts is not built in this pre-release.`)
  return handler
}

/** `runTool` as the old provider tests call it, over the shipped provider handlers. */
export async function runTool(name: string, raw: unknown, call: ToolCall, runner: Runner): Promise<unknown> {
  const deps = runner.deps
  const input = raw !== null && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  try {
    if (name === "plan") return await plan(input, call, runner)
    if (name === "write" || name === "delete") return await commit(name, input, call, runner)
    const handler = name === "status" ? cost.HANDLERS.status : PACKAGE_HANDLERS[name]
    if (handler === undefined) throw new Error(`no provider handler for ${name}`)
    const account = resolveAccount(deps.options, typeof input["account"] === "string" ? input["account"] : undefined)
    if (WRITES.has(name)) assertWritable(account)
    const parsed = CONTRACTS[name as ToolName].input.parse({ ...input, account: account.alias })
    const base = providerContext(deps, account, callOf(call, account.alias))
    const seen = new Set<string>()
    const ctx = {
      ...base,
      async providerRead(operation: string) {
        call.signal.throwIfAborted()
        const resource = `${account.alias}:${operation}`
        if (seen.has(resource)) return
        seen.add(resource)
        await runner.assert({
          sessionID: call.sessionID,
          agent: call.agent,
          action: "colab.read",
          resources: [resource],
          save: [resource],
          metadata: { account: account.alias, operation },
          source: { type: "tool", messageID: call.messageID, id: call.id },
        })
      },
    }
    const metadata = handler.metadata ? await handler.metadata(parsed as never, ctx as never) : { account: account.alias }
    await runner.assert({
      sessionID: call.sessionID,
      agent: call.agent,
      action: `colab.${name}`,
      resources: [account.alias],
      save: [account.alias],
      metadata,
      source: { type: "tool", messageID: call.messageID, id: call.id },
    })
    return await handler.run(parsed as never, ctx as never)
  } catch (error) {
    const refused = failure(error) ?? (error instanceof z.ZodError ? { state: "refused", error: "INPUT_INVALID", message: "The input does not fit the tool's schema.", next: "Pass only the input the tool's schema describes." } : error instanceof Error && error.name === "AbortError" ? { state: "failed", error: "CANCELLED", message: "The call was cancelled.", next: "Call it again if you still need the result." } : undefined)
    if (refused !== undefined) return refused
    throw error
  }
}

function readRecordingContext(deps: Deps, account: ResolvedAccount, call: ToolCall, runner: Runner) {
  const base = providerContext(deps, account, callOf(call, account.alias))
  const seen = new Set<string>()
  return { ...base, async providerRead(operation: string) {
    call.signal.throwIfAborted()
    const resource = `${account.alias}:${operation}`
    if (seen.has(resource)) return
    seen.add(resource)
    await runner.assert({ sessionID: call.sessionID, agent: call.agent, action: "colab.read", resources: [resource], save: [resource], metadata: { account: account.alias, operation }, source: { type: "tool", messageID: call.messageID, id: call.id } })
  } }
}

async function plan(input: Record<string, unknown>, call: ToolCall, runner: Runner): Promise<unknown> {
  const action = typeof input["action"] === "string" ? input["action"] : ""
  const account = resolveAccount(runner.deps.options, typeof input["account"] === "string" ? input["account"] : undefined)
  assertWritable(account)
  const handler = providerPlan(action, account.backend)
  const params = PLAN_PARAMS[action as PlanAction].parse(input["params"] ?? {})
  const ctx = readRecordingContext(runner.deps, account, call, runner)
  await runner.assert({ sessionID: call.sessionID, agent: call.agent, action: "colab.plan", resources: [account.alias], save: [account.alias], metadata: { account: account.alias, action }, source: { type: "tool", messageID: call.messageID, id: call.id } })
  const previewed = await handler.preview(params as never, ctx as never)
  const item = PLAN_ACTIONS[action as PlanAction]
  const planId = `plan_test_${nextPlan++}`
  const stored: StoredPlan = {
    preview: previewed.preview,
    payload: previewed.payload,
    fingerprint: previewed.fingerprint,
    account: account.alias,
    category: item.category,
    action: action as PlanAction,
    operation: (item.backends as Partial<Record<Backend, { readonly operation: string }>>)[account.backend]!.operation,
  }
  plans.set(planId, stored)
  return {
    state: "ok",
    planId,
    action,
    category: item.category,
    commit: `colab_${item.category === "write" ? "write" : "delete"}`,
    expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
    preview: previewed.preview,
    ...(previewed.warnings?.length ? { warnings: [...previewed.warnings] } : {}),
  }
}

async function commit(name: "write" | "delete", input: Record<string, unknown>, call: ToolCall, runner: Runner): Promise<unknown> {
  const planId = typeof input["planId"] === "string" ? input["planId"] : ""
  const stored = plans.get(planId)
  if (stored === undefined) throw new ColabError("PLAN_NOT_FOUND")
  if (stored.failed) throw new ColabError("PLAN_EXPIRED", "The plan's commit failed, so it is spent.")
  if (stored.used) throw new ColabError("PLAN_ALREADY_USED", "This plan was already committed.")
  const wanted = name === "write" ? "write" : "delete"
  if (stored.category !== wanted) throw new ColabError("CATEGORY_MISMATCH", `This is a ${stored.category} plan.`, { next: `Commit it with colab_${stored.category}, passing only {planId}.` })
  const account = resolveAccount(runner.deps.options, stored.account)
  assertWritable(account)
  await runner.assert({ sessionID: call.sessionID, agent: call.agent, action: `colab.${name}`, resources: [`${account.alias}:${stored.operation}`], save: name === "write" ? [`${account.alias}:${stored.operation}`] : undefined, metadata: { account: account.alias, action: stored.action }, source: { type: "tool", messageID: call.messageID, id: call.id } } as never)
  const handler = providerPlan(stored.action, account.backend)
  stored.used = true
  try {
    const result = await handler.commit({ payload: stored.payload, fingerprint: stored.fingerprint }, readRecordingContext(runner.deps, account, call, runner) as never)
    return { state: "ok", planId, action: stored.action, result }
  } catch (error) {
    stored.failed = true
    throw error
  }
}

/** The stored plan a provider plan test inspects, in the old `StoredPlan` shape. */
export function planForTest(planId: string): Record<string, unknown> {
  const stored = plans.get(planId)
  if (stored === undefined) throw new Error(`no test plan ${planId}`)
  return { ...stored }
}

export { PLAN_PARAMS }
