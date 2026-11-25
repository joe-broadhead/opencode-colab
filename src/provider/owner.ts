/**
 * Whose a source is, as `probe` and every page name it.
 *
 * `colab.runs` reads this computer's ledger, so its owner is local: `os-user:<user>@<computer>`. `colab.runtimes` reads
 * Google's listing for the signed-in account, so its owner is the account's verified email or, when Google does not
 * vouch for one, the plugin's own scheme-qualified `colab:account:<alias>`.
 */
import { hostname, userInfo } from "node:os"
import type { EventsOwner } from "@we-the-rebel-alliance/plugin-contract/events"
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Deps } from "./index.js"
import type { ResolvedAccount } from "../options.js"

/** The plugin's synthetic owner id for an account Google does not name. */
export const syntheticOwnerId = (alias: string) => `colab:account:${alias}`

const cutLabel = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 199)}…`)

const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)

export function localOwnerOf(user: string, host: string): EventsOwner {
  const computer = slug(host.replace(/\.local\.?$/i, ""), 63) || "local"
  const name = slug(user, 64) || "user"
  return { id: `os-user:${name}@${computer}`, label: `${name} on ${computer}` }
}

/** This process's OS user and computer. */
export function localOwner(): EventsOwner {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = process.env.USER ?? process.env.LOGNAME ?? ""
  }
  return localOwnerOf(user, hostname())
}

function notSignedIn(alias: string): RegisterError {
  return new RegisterError(
    refusal("NEEDS_SIGN_IN", `The Colab account "${alias}" is not signed in`, `Sign in with /connect and choose Colab, or run opencode auth login ${alias === "default" ? "colab" : `colab-${alias}`}, then call it again.`),
  )
}

/** The Google owner of `account`, or NEEDS_SIGN_IN when it has no credential. */
export async function googleOwner(deps: Pick<Deps, "auth">, account: ResolvedAccount, signal: AbortSignal): Promise<EventsOwner> {
  const alias = account.alias
  if (account.mode === "interactive") {
    const scopes = await deps.auth.scopes(alias)
    if (scopes.length === 0) throw notSignedIn(alias)
  } else if (account.mode === "token") {
    await deps.auth.token(alias, [], signal).catch(() => {
      throw notSignedIn(alias)
    })
    return { id: syntheticOwnerId(alias), label: cutLabel(`${alias} (an access token from the environment; Google is not asked whose it is)`) }
  }
  const identity = await deps.auth.identity(alias, signal).catch(() => undefined)
  if (identity && identity.verified && identity.email.includes("@")) return { id: `mailto:${identity.email}`, label: cutLabel(identity.email) }
  const why = account.mode === "adc" ? "application default credentials that name no email" : "Google named no verified email at sign-in"
  return { id: syntheticOwnerId(alias), label: cutLabel(`${alias} (${why})`) }
}
