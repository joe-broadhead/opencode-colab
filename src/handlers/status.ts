/**
 * `status`: the contract's one short answer, assembled by `statusAnswer` from the manifest, the versions, every alias's
 * state and the agents the generated access rules miss. No content, no token, no provider request.
 */
import { accountStatuses, NO_ACCOUNTS, redactReason, STATUS_SCHEMA, statusAnswer, type AccountSignal, type AccountStatus } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { DISPLAY_NAME } from "../constants.js"
import type { Manifest } from "../manifest.js"
import type { Deps } from "../provider/index.js"
import { googleOwner, localOwner, syntheticOwnerId } from "../provider/owner.js"
import type { ResolvedAccount } from "../options.js"

const EMPTY = { type: "object", properties: {}, additionalProperties: false }

/** One alias's state, without a Google call: the host's credential store, ADC metadata or an environment variable. */
export async function accountSignal(deps: Deps, account: ResolvedAccount): Promise<AccountSignal> {
  try {
    if (account.mode === "interactive") {
      const scopes = await deps.auth.scopes(account.alias)
      if (scopes.length === 0) return { state: "needs_sign_in" }
      return { state: "ready", owner: await googleOwner(deps, account, new AbortController().signal) }
    }
    if (account.mode === "token") {
      const value = account.tokenEnv ? process.env[account.tokenEnv] : undefined
      if (!value || value.trim() === "") return { state: "needs_sign_in" }
      return { state: "ready", owner: { id: syntheticOwnerId(account.alias), label: `${account.alias} (an access token from the environment)` } }
    }
    const identity = await deps.auth.identity(account.alias, new AbortController().signal).catch(() => undefined)
    if (identity && identity.verified && identity.email.includes("@")) return { state: "ready", owner: { id: `mailto:${identity.email}`, label: identity.email } }
    return { state: "needs_sign_in" }
  } catch (error) {
    return { state: "error", reason: redactReason(error instanceof Error ? error.message : String(error)) }
  }
}

export interface StatusHandlerInput {
  readonly manifest: Manifest
  readonly version: string
  readonly hostVersion: string
  readonly profiles: readonly ResolvedAccount[]
  readonly problems: readonly string[]
  readonly deps: Deps
}

export function statusHandler(input: StatusHandlerInput): MethodHandler {
  return {
    description: `Read ${DISPLAY_NAME}'s state, its host range, every account alias and what to do next. It reads no content.`,
    input: EMPTY,
    output: STATUS_SCHEMA,
    async run(_input, call) {
      const problems = [...input.problems]
      const signals: Record<string, AccountSignal> = {}
      await Promise.all(
        input.profiles.map(async (account) => {
          signals[account.alias] = await accountSignal(input.deps, account)
        }),
      )
      const accounts: readonly AccountStatus[] = input.profiles.length === 0 ? [...NO_ACCOUNTS] : accountStatuses(input.profiles.map((account) => ({ alias: account.alias })), signals)
      return statusAnswer({
        manifest: input.manifest,
        version: input.version,
        hostVersion: input.hostVersion,
        accounts,
        problems,
        unguardedAgents: await call.unguardedAgents(),
      })
    },
  }
}

/** Kept for the command and tests that need the local owner without a Google read. */
export { localOwner }
