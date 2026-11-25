/**
 * Provider-suite calls through the shipped handler table, the way the register calls it.
 *
 * A fake `MethodCall` carries the resolved account, a recording bus, the session the call is on and, for a commit, the
 * plan answer the real planning handler produced. A refusal is the contract's `RegisterError` — the handler table's own
 * `mapped()` has already turned every provider error into a contract code. There is no second plan store and no second
 * refusal vocabulary here: tests that assert the register's plan lifetime belong in `test/unit/plans.test.ts` or the
 * host test.
 */
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { PLAN_ACTIONS, type PlanAction } from "../../src/domain/actions.js"
import { providerContext } from "../../src/handlers/context.js"
import { createHandlers } from "../../src/handlers/index.js"
import { manifest, version } from "../../src/manifest.js"
import { type ResolvedAccount, resolveAccount } from "../../src/options.js"
import * as enterprise from "../../src/provider/enterprise/index.js"
import * as execution from "../../src/provider/execution/index.js"
import type { Deps } from "../../src/provider/index.js"
import * as notebooks from "../../src/provider/notebooks/index.js"

export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export interface Runner {
  readonly deps: Deps
}

export interface Emitted {
  readonly name: string
  readonly data: unknown
}

/** What a provider test reads back: an ok answer or the contract refusal, in the old result envelope. */
export interface Answer {
  readonly state: "ok" | "refused" | "failed"
  readonly error?: string
  readonly message?: string
  readonly next?: string
  readonly [key: string]: unknown
}

const PROVIDER_METHODS = { ...notebooks.HANDLERS, ...execution.HANDLERS, ...enterprise.HANDLERS } as Readonly<Record<string, { metadata?: (input: never, ctx: never) => Promise<unknown>; run: (input: never, ctx: never) => Promise<unknown> }>>

/** Call one provider handler directly, for the ask/run pair that the wrapper's metadata call precedes. */
export async function providerRun(name: string, raw: unknown, call: ToolCall, runner: Runner): Promise<unknown> {
  const input = raw !== null && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  const alias = typeof input["account"] === "string" ? input["account"] : undefined
  delete input["account"]
  const account = resolveAccount(runner.deps.options, alias)
  const handler = PROVIDER_METHODS[name]
  if (handler === undefined) throw new Error(`${name} has no provider handler`)
  return handler.run(input as never, providerContext(runner.deps, account, methodCall(call, account, [], undefined)) as never)
}

/** The provider handler's own preview metadata, the object a run's ask is bound to. */
export async function metadataFor(name: string, raw: unknown, runner: Runner, id = "call_metadata"): Promise<Record<string, unknown>> {
  const input = raw !== null && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  const alias = typeof input["account"] === "string" ? input["account"] : undefined
  delete input["account"]
  const account = resolveAccount(runner.deps.options, alias)
  const handler = PROVIDER_METHODS[name]
  if (handler?.metadata === undefined) throw new Error(`${name} has no metadata`)
  const call: ToolCall = { sessionID: "ses_metadata", agent: "build", messageID: "msg_metadata", id, signal: new AbortController().signal }
  return (await handler.metadata(input as never, providerContext(runner.deps, account, methodCall(call, account, [], undefined)) as never)) as Record<string, unknown>
}

function handlers(deps: Deps) {
  return createHandlers({ deps, manifest, version, hostVersion: "2.4.1", profiles: deps.options.accounts, problems: [] })
}

function methodCall(call: ToolCall, account: ResolvedAccount, emitted: Emitted[], plan: unknown): MethodCall {
  return {
    sessionID: call.sessionID,
    agent: call.agent,
    messageID: call.messageID,
    id: call.id,
    signal: call.signal,
    progress: async () => undefined,
    account: account.alias,
    bus: {
      emit: async (name: string, data: unknown) => {
        emitted.push({ name, data })
        return { ok: true as const }
      },
    },
    unguardedAgents: async () => ({ ok: true, agents: [] }),
    door: "rpc",
    ...(plan !== undefined ? { plan } : {}),
  } as unknown as MethodCall
}

/** Call one shipped method; `plan` (a planning handler's whole answer) is the commit's `call.plan`. */
export async function callMethod(name: string, raw: unknown, call: ToolCall, runner: Runner, plan?: unknown): Promise<Answer> {
  const deps = runner.deps
  const input = raw !== null && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {}
  const alias = typeof input["account"] === "string" ? input["account"] : undefined
  delete input["account"]
  const carried = plan ?? input["plan"]
  delete input["plan"]
  try {
    const account = resolveAccount(deps.options, alias)
    const table = handlers(deps)
    const emitted: Emitted[] = []
    const context = methodCall(call, account, emitted, carried)
    if (name === "plan") {
      const action = typeof input["action"] === "string" ? input["action"] : ""
      const category = (PLAN_ACTIONS as Readonly<Record<string, { readonly category: "write" | "delete" }>>)[action]?.category
      const answer = (await table[category === "delete" ? "plan_delete" : "plan_write"]!.run(input, context)) as Record<string, unknown>
      return {
        ...answer,
        state: "ok",
        action,
        ...(category !== undefined ? { category } : {}),
        commit: `colab_${String(answer["method"])}`,
        preview: answer["output"],
        // The register keeps the planning handler's whole answer and hands it back as `call.plan`.
        plan: answer,
      }
    }
    if (name === "write" || name === "delete") {
      return (await table[name]!.run({}, context)) as Answer
    }
    return (await table[name]!.run(input, context)) as Answer
  } catch (error) {
    if (error instanceof RegisterError) {
      return {
        state: error.refusal.code === "UNAVAILABLE" ? "failed" : "refused",
        error: error.refusal.code,
        message: error.refusal.what,
        next: error.refusal.next,
      }
    }
    throw error
  }
}

/** `runTool` as the provider suites call it, now over the shipped handler table. */
export const runTool = (name: string, raw: unknown, call: ToolCall, runner: Runner, plan?: unknown): Promise<unknown> =>
  callMethod(name, raw, call, runner, plan)

/** The private plan a planning answer carries, for a test that inspects the payload the commit re-checks. */
export function planOf(answer: unknown): Record<string, unknown> {
  return (answer as { plan: { plan: Record<string, unknown> } }).plan.plan
}

export type { PlanAction }
