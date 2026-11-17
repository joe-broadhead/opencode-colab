/**
 * The OAuth client a sign-in uses, and where it came from (design §4, gws's client mechanism).
 *
 * No client ships in the package. A person uses their own Desktop app client, or one the organisation sets through
 * `oauthClient`; Jelly fills its hosted client into the form's hidden `clientJson` field (`package.json`
 * `jelly.signIns[0].hostClient`). Google treats an installed app's secret as non-confidential
 * (https://developers.google.com/identity/protocols/oauth2/native-app): security rests on PKCE (S256), the loopback
 * redirect, and consent on Google's own screen, not on the secret. The secret still never appears in a message, a log
 * line or a form description.
 */

export interface OAuthClient {
  readonly clientId: string
  readonly clientSecret: string
  /** A Web application client's registered redirect URIs; absent for a Desktop app client. */
  readonly redirectUris?: readonly string[]
}

/** Where a sign-in's client came from: the account option, the plugin option, or the form. */
export type ClientSource = "account" | "plugin" | "pasted"

export interface ClientChoice {
  readonly client: OAuthClient
  readonly source: ClientSource
}

const CLIENT_ID = /^[A-Za-z0-9-]+\.apps\.googleusercontent\.com$/
const CLIENT_SECRET = /^[A-Za-z0-9_-]+$/

export const isClientId = (value: string): boolean => CLIENT_ID.test(value)
export const isClientSecret = (value: string): boolean => CLIENT_SECRET.test(value)

/** A client ID and secret, checked. A malformed pair names the format, never the value. */
export function desktopClient(clientId: string, clientSecret: string): OAuthClient | undefined {
  const id = clientId.trim()
  const secret = clientSecret.trim()
  if (!isClientId(id) || !isClientSecret(secret)) return undefined
  return { clientId: id, clientSecret: secret }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Google's downloaded client JSON: `{"installed": …}` for a Desktop app client, or `{"web": …}` for a Web application
 * client, which carries its registered redirect URIs. Other keys (`project_id`, `auth_uri`, …) are ignored.
 */
export function clientFromJson(text: string): OAuthClient | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  const installed = parsed["installed"]
  if (isRecord(installed)) {
    const clientId = typeof installed["client_id"] === "string" ? installed["client_id"] : ""
    const clientSecret = typeof installed["client_secret"] === "string" ? installed["client_secret"] : ""
    return desktopClient(clientId, clientSecret)
  }
  const web = parsed["web"]
  if (isRecord(web)) {
    const clientId = typeof web["client_id"] === "string" ? web["client_id"] : ""
    const clientSecret = typeof web["client_secret"] === "string" ? web["client_secret"] : ""
    const redirects = Array.isArray(web["redirect_uris"]) ? web["redirect_uris"].filter((item): item is string => typeof item === "string" && item.length > 0) : []
    const base = desktopClient(clientId, clientSecret)
    if (!base) return undefined
    return { ...base, redirectUris: redirects.length > 0 ? redirects : [] }
  }
  return undefined
}

/**
 * One `oauthClient` option: Google's downloaded client JSON, or `<clientId>:<clientSecret>` for a Desktop app client.
 * Undefined when it is neither.
 */
export function clientFromOption(value: string): OAuthClient | undefined {
  const json = clientFromJson(value)
  if (json) return json
  const separator = value.indexOf(":")
  if (separator > 0) return desktopClient(value.slice(0, separator), value.slice(separator + 1))
  return undefined
}

export interface ClientCandidates {
  /** `accounts.<alias>.oauthClient`. */
  readonly account?: OAuthClient
  /** The plugin `oauthClient` (managed config). */
  readonly plugin?: OAuthClient
  /** The client entered in the sign-in form. */
  readonly pasted?: OAuthClient
  /** The client of the account's current sign-in, reused only when it was entered in the form. */
  readonly previous?: ClientChoice
}

/**
 * Client precedence, first match wins (design §4, gws):
 * `accounts.<alias>.oauthClient`, the plugin `oauthClient`, the client entered in the form, the client entered at the
 * previous sign-in. With none, the sign-in stops with AUTH_CLIENT_REQUIRED before any network call.
 */
export function resolveClient(candidates: ClientCandidates): ClientChoice | undefined {
  if (candidates.account) return { client: candidates.account, source: "account" }
  if (candidates.plugin) return { client: candidates.plugin, source: "plugin" }
  if (candidates.pasted) return { client: candidates.pasted, source: "pasted" }
  return candidates.previous?.source === "pasted" ? candidates.previous : undefined
}

/**
 * A redirect Google would refuse, checked before anything listens or the browser opens: a Desktop app client accepts
 * only a loopback redirect, and a Web application client accepts only a redirect it lists, character for character.
 * Undefined when the pair is consistent.
 */
export function redirectMismatch(client: OAuthClient, redirectUri: string | undefined): string | undefined {
  if (client.redirectUris) {
    if (!redirectUri) return "a Web application client needs a fixed redirect URI, and none is set"
    if (!client.redirectUris.includes(redirectUri)) return "the redirect URI is not one of the Web client's registered redirect URIs; Google matches them exactly"
    return undefined
  }
  if (redirectUri && !isLoopback(redirectUri)) return "a Desktop app client accepts only an http loopback redirect, and this one is not loopback"
  return undefined
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

/** True for an http redirect to this machine, the only kind a Desktop app client accepts. */
export function isLoopback(uri: string): boolean {
  try {
    const url = new URL(uri)
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}
