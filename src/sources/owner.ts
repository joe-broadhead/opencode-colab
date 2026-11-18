/**
 * Whose a source is, as `probe` and every page name it (design §11). Each source names the owner of what it reads:
 *
 * - **colab.runs** reads this computer's ledger, which records runs by account alias, not by Google identity (a run made
 *   under an earlier sign-in of the same alias is in it too). Its owner is local, as the family's other ledger source
 *   (boxd's `boxd.works`) names it: `os-user:<user>@<computer>`, labelled `<user> on <computer>`. It needs no sign-in
 *   and reads no credential.
 * - **colab.runtimes** reads Google's listing for the signed-in account. Its owner is that account: the email in the ID
 *   token Google returned at sign-in (package A keeps its claims with the credential), or an ADC key's service-account
 *   email. It calls no Google API.
 *
 * No owner carries `verified: false`: Jelly and Memory still vendor source-contract v0.1.x, which refuses the key
 * (SC-SOURCES-BRIEF, CORRECTIONS 5). Where Google does not vouch for an email — a `token` account, an ADC credential
 * with no readable email, an ID token whose email Google marks unverified — the owner is the plugin's own synthetic,
 * scheme-qualified id, `colab:account:<alias>`, and its label says why. It is never presented as the person's email.
 */
import { hostname, userInfo } from "node:os"
import { SourceError, type EventsOwner } from "@we-the-rebel-alliance/source-contract/events"
import type { Deps } from "../deps.js"
import type { ResolvedAccount } from "../options.js"
import { asSource } from "./errors.js"

/** The plugin's synthetic owner id for an account Google does not name. */
export const syntheticOwnerId = (alias: string) => `colab:account:${alias}`

const cutLabel = (text: string) => (text.length <= 200 ? text : `${text.slice(0, 199)}…`)

const slug = (text: string, max: number) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, max)

/** The local owner for an OS user and a computer's host name, as given. */
export function localOwnerOf(user: string, host: string): EventsOwner {
  const computer = slug(host.replace(/\.local\.?$/i, ""), 63) || "local"
  const name = slug(user, 64) || "user"
  return { id: `os-user:${name}@${computer}`, label: `${name} on ${computer}` }
}

/** This process's OS user and computer. A user with no password entry, as in some containers, falls back to $USER. */
export function localOwner(): EventsOwner {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = process.env.USER ?? process.env.LOGNAME ?? ""
  }
  return localOwnerOf(user, hostname())
}

function notSignedIn(alias: string): SourceError {
  return new SourceError({
    code: "NEEDS_SIGN_IN",
    what: `The Colab account "${alias}" is not signed in`,
    next: `Sign in with /connect and choose Colab, or run opencode auth login colab-${alias}, then call it again.`,
  })
}

/** The Google owner of `account`, or NEEDS_SIGN_IN when it has no credential. */
export async function googleOwner(deps: Pick<Deps, "auth">, account: ResolvedAccount, signal: AbortSignal): Promise<EventsOwner> {
  return asSource(async () => {
    const alias = account.alias
    if (account.mode === "interactive") {
      const scopes = await deps.auth.scopes(alias)
      if (scopes.length === 0) throw notSignedIn(alias)
    } else if (account.mode === "token") {
      // The token is read from the environment, never sent anywhere here: a missing variable is a missing sign-in.
      await deps.auth.token(alias, [], signal).catch(() => {
        throw notSignedIn(alias)
      })
      return { id: syntheticOwnerId(alias), label: cutLabel(`${alias} (an access token from the environment; Google is not asked whose it is)`) }
    }
    const identity = await deps.auth.identity(alias, signal)
    if (identity && identity.verified && identity.email.includes("@")) return { id: `mailto:${identity.email}`, label: cutLabel(identity.email) }
    const why = account.mode === "adc" ? "application default credentials that name no email" : "Google named no verified email at sign-in"
    return { id: syntheticOwnerId(alias), label: cutLabel(`${alias} (${why})`) }
  })
}
