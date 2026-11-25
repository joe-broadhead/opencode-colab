/**
 * The handler contract shared by the provider's plan handlers and the method handlers: the call, the provider, the
 * resolved account, and the preview/commit pair for a planned change. The contract's `register` owns permissions,
 * account resolution, input checks and the plan id; a handler only does the work.
 */
import type * as z from "zod"
import type { Backend, Operation, PlanAction } from "../domain/actions.js"
import type { InputOf, OutputOf, PLAN_PARAMS, ToolName } from "../domain/contract.js"
import type { WarningCode } from "../domain/errors.js"
import type { Deps } from "./index.js"
import type { ResolvedAccount } from "../options.js"

/** The call a handler runs for: the host's tool call or an RPC call, reduced to what the provider needs. */
export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

/** What every handler gets: the call and the provider. */
export interface CallContext {
  readonly call: ToolCall
  readonly deps: Deps
}

/**
 * A handler's context. `providerRead` only checks the call's signal: the register asserts the method's declared
 * operations once, through `ctx.permission.assert`, before the handler runs.
 */
export interface HandlerContext extends CallContext {
  readonly account: ResolvedAccount
  providerRead(operation: Operation): Promise<void>
}

/** A tool's handler: the parsed input in, the tool's result out. Throw a ColabError for a refusal or failure. */
export interface ToolHandler<N extends ToolName> {
  metadata?(input: InputOf<N>, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>>
  run(input: InputOf<N>, ctx: HandlerContext): Promise<OutputOf<N>>
}

export type ToolHandlers = { readonly [N in ToolName]?: ToolHandler<N> }

export type PlanParams<A extends PlanAction> = z.output<(typeof PLAN_PARAMS)[A]>

export interface PlanPreview {
  /** What the person sees: secret-screened; no token, runtime URL or notebook text beyond the screened excerpts. */
  readonly preview: Readonly<Record<string, unknown>>
  /** What commit needs; never shown to the person, kept in the register's plan. */
  readonly payload: Readonly<Record<string, unknown>>
  /** What commit re-reads and compares: a difference is PLAN_CHANGED. */
  readonly fingerprint: Readonly<Record<string, unknown>>
  readonly warnings?: readonly WarningCode[]
}

/** What a commit receives from the register: the preview's private payload and the fingerprint it must re-check. */
export interface PlannedChange {
  readonly payload: Readonly<Record<string, unknown>>
  readonly fingerprint: Readonly<Record<string, unknown>>
}

export interface PlanHandler<A extends PlanAction> {
  preview(params: PlanParams<A>, ctx: HandlerContext): Promise<PlanPreview>
  /** Re-reads the target; a difference from the fingerprint throws PLAN_CHANGED. Returns the provider's answer, redacted. */
  commit(plan: PlannedChange, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>>
}

export type PlanHandlers = { readonly [A in PlanAction]?: Partial<Record<Backend, PlanHandler<A>>> }
