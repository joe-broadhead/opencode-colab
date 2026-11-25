/**
 * The adapter between a provider handler's context and the contract's call: the resolved account, the provider, a
 * signal check in place of the register's own permission gate, and the file-safety calls the provider already makes.
 */
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { ColabError } from "../domain/errors.js"
import { resolveAccount, type ResolvedAccount } from "../options.js"
import type { Deps } from "../provider/index.js"
import type { HandlerContext, ToolCall } from "../provider/types.js"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"

/** The provider's account for a contract alias. The register has already resolved the alias. */
export function providerAccount(deps: Pick<Deps, "options">, alias: string): ResolvedAccount {
  try {
    return resolveAccount(deps.options, alias)
  } catch (error) {
    if (ColabError.is(error)) throw new RegisterError(refusal("ACCOUNT_UNKNOWN", error.detail, error.next))
    throw error
  }
}

/** A read account makes no change: refuse it before any provider call. */
export function assertWritable(account: Pick<ResolvedAccount, "alias" | "access">): void {
  if (account.access !== "read") return
  throw new RegisterError(
    refusal("PERMISSION_DENIED", `The account "${account.alias}" has access read, so the plugin makes no change on it`, `Set accounts.${account.alias}.access to write and sign in again.`),
  )
}

/** The provider's handler context for one call. Permission and operation assertions are the register's. */
export function providerContext(deps: Deps, account: ResolvedAccount, call: MethodCall): HandlerContext {
  return {
    call: { sessionID: call.sessionID, agent: call.agent, messageID: call.messageID, id: call.id, signal: call.signal } satisfies ToolCall,
    deps,
    account,
    async providerRead() {
      call.signal.throwIfAborted()
    },
  }
}
