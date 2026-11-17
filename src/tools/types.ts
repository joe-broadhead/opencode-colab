/**
 * What a package implements: a handler per tool it owns, and a plan handler per plan action and backend it owns
 * (src/domain/actions.ts, `owner`). The registry (src/tools/registry.ts) wraps each handler so that it parses its
 * input, resolves the account and asserts its action before the handler runs; a handler never asserts its own tool
 * action again. A handler asserts `colab.read` once per provider read through `ctx.providerRead` (design §10).
 */
import type * as z from "zod"
import type { Backend, Operation, PlanAction } from "../domain/actions.js"
import type { InputOf, OutputOf, PLAN_PARAMS, ToolName } from "../domain/contract.js"
import type { WarningCode } from "../domain/errors.js"
import type { Deps } from "../deps.js"
import type { ResolvedAccount } from "../options.js"
import type { StoredPlan } from "../ports.js"

/** The call a handler runs for: the model's tool context or a script's RPC call. */
export interface ToolCall {
  readonly sessionID: string
  readonly agent: string
  readonly messageID: string
  readonly id: string
  readonly signal: AbortSignal
}

export interface HandlerContext {
  readonly call: ToolCall
  /** The account the call named, or the default one. Absent only for colab_write and colab_delete before the plan is read. */
  readonly account: ResolvedAccount
  readonly deps: Deps
  /** Asserts `colab.read` on `<account>:<operation>`: call it before each provider read, once per operation and call. */
  providerRead(operation: Operation): Promise<void>
}

/** A tool's handler: the parsed input in, the tool's result out. Throw a ColabError for a refusal or failure. */
export interface ToolHandler<N extends ToolName> {
  /**
   * The ask's metadata, computed before the assert: `colab_run` puts each cell's first 6 lines, the sources' sha256
   * and the flagged shell, install and network lines here (design §7.3). Never a token or the runtime URL.
   */
  metadata?(input: InputOf<N>, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>>
  run(input: InputOf<N>, ctx: HandlerContext): Promise<OutputOf<N>>
}

export type ToolHandlers = { readonly [N in ToolName]?: ToolHandler<N> }

export type PlanParams<A extends PlanAction> = z.output<(typeof PLAN_PARAMS)[A]>

export interface PlanPreview {
  /** What the person sees: secret-screened; no token, runtime URL or notebook text beyond the screened excerpts. */
  readonly preview: Readonly<Record<string, unknown>>
  /** What commit needs; never shown. */
  readonly payload: Readonly<Record<string, unknown>>
  /** What commit re-reads and compares (design §7.2): eligibility, state, hash, revision, estimate. */
  readonly fingerprint: Readonly<Record<string, unknown>>
  readonly warnings?: readonly WarningCode[]
}

export interface PlanHandler<A extends PlanAction> {
  preview(params: PlanParams<A>, ctx: HandlerContext): Promise<PlanPreview>
  /** Re-reads the target; a difference from the fingerprint throws PLAN_CHANGED. Returns Google's answer, redacted. */
  commit(plan: StoredPlan, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>>
}

export type PlanHandlers = { readonly [A in PlanAction]?: Partial<Record<Backend, PlanHandler<A>>> }
