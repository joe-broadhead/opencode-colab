/**
 * Application Default Credentials, impersonation and token mode for Enterprise accounts (design §4, §13).
 *
 * ADC is opt-in and never a fallback: only `mode: "adc"` uses it, only on an `enterprise` account (the options refuse
 * it on a consumer account), and it is refused under a managed (hosted) OpenCode unless `allowAdcInHost` is set. ADC
 * looks where Google's libraries look, in Google's order (https://cloud.google.com/docs/authentication/application-default-credentials):
 * 1. the JSON file the GOOGLE_APPLICATION_CREDENTIALS variable names,
 * 2. the file `gcloud auth application-default login` writes
 *    (`$CLOUDSDK_CONFIG/application_default_credentials.json`, else `~/.config/gcloud/…`; `%APPDATA%\gcloud\…` on
 *    Windows),
 * 3. the metadata server.
 *
 * Shapes: a service account key signs the JWT bearer grant (`iss`, `scope`, `aud`, `exp`, `iat`; `grant_type=
 * urn:ietf:params:oauth:grant-type:jwt-bearer`) from "Using OAuth 2.0 for server to server applications"
 * (https://developers.google.com/identity/protocols/oauth2/service-account); a `gcloud` user credential refreshes like
 * any refresh token; impersonation POSTs `{scope, lifetime}` to
 * `iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/<email>:generateAccessToken` and reads
 * `{accessToken? no: accessToken, expireTime}` (https://cloud.google.com/iam/docs/create-short-lived-credentials-direct).
 *
 * Not in this build: Workforce/Workload Identity Federation (`external_account`) credential files; the refusal names the
 * live check that would add them (L3). No token, key or refresh token reaches a message.
 */
import { createSign } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { ColabError } from "../domain/errors.js"
import { redact } from "../redact.js"
import { requestTokens, googleFetch } from "./google.js"
import { TOKEN_ENDPOINT } from "./pkce.js"
import { SCOPES } from "./scopes.js"

export const IAM_CREDENTIALS_ENDPOINT = "https://iamcredentials.googleapis.com/v1"
export const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
export const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer"

/** What one ADC source is, after parsing; only the fields the plugin uses. */
export interface ServiceAccountKey {
  readonly type: "service_account"
  readonly client_email: string
  readonly private_key: string
  readonly private_key_id?: string
}

export interface AuthorizedUser {
  readonly type: "authorized_user"
  readonly client_id: string
  readonly client_secret: string
  readonly refresh_token: string
}

export type AdcSource = ServiceAccountKey | AuthorizedUser | { readonly type: "external_account" } | { readonly type: "metadata" }

export interface AdcEnvironment {
  readonly env?: NodeJS.ProcessEnv
  readonly readFile?: (path: string) => string | undefined
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

/** The gcloud ADC file's path for this operating system, as Google documents it; undefined when there is no home. */
export function gcloudAdcPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.CLOUDSDK_CONFIG) return join(env.CLOUDSDK_CONFIG, "application_default_credentials.json")
  if (process.platform === "win32") return env.APPDATA ? join(env.APPDATA, "gcloud", "application_default_credentials.json") : undefined
  return env.HOME ? join(env.HOME, ".config", "gcloud", "application_default_credentials.json") : undefined
}

/**
 * A managed (hosted) engine disables the project config; the host's own agent runtime sets both variables for its
 * managed engines, so their presence is the signal that ADC is not the local person's own credential, and it is refused
 * unless the operator opted in (design §4, ADC_REFUSED).
 */
export function isManagedHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OPENCODE_DISABLE_PROJECT_CONFIG === "1" || env.OPENCODE_CONFIG_PROJECT_DISABLE === "1"
}

function unavailable(detail: string, next?: string): ColabError {
  return new ColabError("ADC_UNAVAILABLE", detail, next ? { next } : {})
}

function parseCredential(text: string, source: string): AdcSource {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw unavailable(`The credentials at ${source} are not JSON.`, "Point GOOGLE_APPLICATION_CREDENTIALS at a service account key, or run gcloud auth application-default login.")
  }
  if (!isRecord(parsed)) throw unavailable(`The credentials at ${source} are not a credential object.`, "Point GOOGLE_APPLICATION_CREDENTIALS at a service account key, or run gcloud auth application-default login.")
  const type = parsed["type"]
  if (type === "service_account") {
    const email = typeof parsed["client_email"] === "string" ? parsed["client_email"] : ""
    const key = typeof parsed["private_key"] === "string" ? parsed["private_key"] : ""
    if (!email || !key) throw unavailable(`The service account key at ${source} lacks client_email or private_key.`, "Download the key again from the Google Cloud console → IAM → Service accounts → Keys.")
    const keyId = typeof parsed["private_key_id"] === "string" && parsed["private_key_id"] ? parsed["private_key_id"] : undefined
    return { type: "service_account", client_email: email, private_key: key, ...(keyId ? { private_key_id: keyId } : {}) }
  }
  if (type === "authorized_user") {
    const clientId = typeof parsed["client_id"] === "string" ? parsed["client_id"] : ""
    const clientSecret = typeof parsed["client_secret"] === "string" ? parsed["client_secret"] : ""
    const refresh = typeof parsed["refresh_token"] === "string" ? parsed["refresh_token"] : ""
    if (!clientId || !clientSecret || !refresh) throw unavailable(`The user credentials at ${source} are incomplete.`, "Run gcloud auth application-default login again.")
    return { type: "authorized_user", client_id: clientId, client_secret: clientSecret, refresh_token: refresh }
  }
  if (type === "external_account") return { type: "external_account" }
  throw unavailable(`The credentials at ${source} are of a kind this version does not read${typeof type === "string" ? ` (${redact(type)})` : ""}.`, "Use a service account key or gcloud auth application-default login.")
}

/** The ADC source the environment provides, in Google's order; `metadata` when neither file exists. */
export function findAdcSource(environment: AdcEnvironment = {}): AdcSource {
  const env = environment.env ?? process.env
  const readFile = environment.readFile ?? defaultReadFile
  const configured = env.GOOGLE_APPLICATION_CREDENTIALS
  if (configured && configured.trim()) {
    const text = readFile(configured.trim())
    if (text === undefined) throw unavailable("GOOGLE_APPLICATION_CREDENTIALS names a file that cannot be read.", "Fix the path, or run gcloud auth application-default login and unset it.")
    return parseCredential(text, "the file the GOOGLE_APPLICATION_CREDENTIALS variable names")
  }
  const path = gcloudAdcPath(env)
  if (path) {
    const text = readFile(path)
    if (text !== undefined) return parseCredential(text, "the gcloud application default credentials file")
  }
  return { type: "metadata" }
}

function defaultReadFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

const b64 = (value: object): string => Buffer.from(JSON.stringify(value)).toString("base64url")

/** The signed JWT a service account key presents to the token endpoint (RS256). */
export function serviceAccountAssertion(key: ServiceAccountKey, scopes: readonly string[], nowMs: number): string {
  const iat = Math.floor(nowMs / 1000)
  const header = { alg: "RS256", typ: "JWT", ...(key.private_key_id ? { kid: key.private_key_id } : {}) }
  const claims = { iss: key.client_email, scope: scopes.join(" "), aud: TOKEN_ENDPOINT, exp: iat + 3600, iat }
  const signingInput = `${b64(header)}.${b64(claims)}`
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.private_key, "base64url")
  return `${signingInput}.${signature}`
}

export interface AdcToken {
  readonly token: string
  readonly expiresAt: number
}

/** A minted token from the metadata server: `{access_token, expires_in, token_type}`. */
async function metadataToken(fetchImpl: typeof globalThis.fetch, now: number, signal?: AbortSignal): Promise<AdcToken> {
  let response: Response
  try {
    response = await googleFetch(METADATA_TOKEN_URL, { method: "GET", headers: { "Metadata-Flavor": "Google" }, ...(signal ? { signal } : {}) }, fetchImpl, {
      metadata: true,
      timeoutMs: 1500,
    })
  } catch {
    if (signal?.aborted) throw new ColabError("CANCELLED")
    throw unavailable("No Application Default Credentials were found: neither GOOGLE_APPLICATION_CREDENTIALS nor a gcloud credentials file is set, and the metadata server did not answer.", "Set GOOGLE_APPLICATION_CREDENTIALS, run gcloud auth application-default login, or use interactive mode.")
  }
  if (!response.ok) throw unavailable("The metadata server refused the request for a token.", "Run on a Google Cloud resource with an attached service account, or set GOOGLE_APPLICATION_CREDENTIALS.")
  const json = (await response.json().catch(() => undefined)) as unknown
  const access = isRecord(json) && typeof json["access_token"] === "string" ? json["access_token"] : ""
  const expiresIn = isRecord(json) && typeof json["expires_in"] === "number" ? json["expires_in"] : 3600
  if (!access) throw unavailable("The metadata server returned no access token.", "Check the attached service account, or set GOOGLE_APPLICATION_CREDENTIALS.")
  return { token: access, expiresAt: now + Math.max(60, expiresIn) * 1000 }
}

/** The base token one ADC source mints, before any impersonation. */
async function sourceToken(source: AdcSource, scopes: readonly string[], environment: Required<Pick<AdcEnvironment, "fetch" | "now">>, signal?: AbortSignal): Promise<AdcToken> {
  if (source.type === "metadata") return metadataToken(environment.fetch, environment.now(), signal)
  if (source.type === "external_account") {
    throw unavailable("Workforce and Workload Identity Federation credential files are not read by this version.", "Use a service account key, run gcloud auth application-default login, or use interactive mode.")
  }
  const now = environment.now()
  if (source.type === "service_account") {
    let assertion: string
    try {
      assertion = serviceAccountAssertion(source, scopes, now)
    } catch {
      throw unavailable("The service account key could not sign the token request.", "Download a new JSON key from the Google Cloud console → IAM → Service accounts → Keys, and point GOOGLE_APPLICATION_CREDENTIALS at it.")
    }
    const body = new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion })
    const tokens = await requestTokens(TOKEN_ENDPOINT, body, environment.fetch, [source.private_key], signal).catch(rethrowAdc)
    return { token: tokens.access, expiresAt: now + tokens.expiresIn * 1000 }
  }
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: source.refresh_token, client_id: source.client_id, client_secret: source.client_secret })
  const tokens = await requestTokens(TOKEN_ENDPOINT, body, environment.fetch, [source.refresh_token, source.client_secret], signal).catch(rethrowAdc)
  return { token: tokens.access, expiresAt: now + tokens.expiresIn * 1000 }
}

/** A token-endpoint refusal with ADC's next step instead of `/connect`. */
function rethrowAdc(error: unknown): never {
  if (ColabError.is(error) && (error.code === "AUTH_REQUIRED" || error.code === "AUTH_CLIENT_REQUIRED")) {
    throw new ColabError(error.code, error.detail, {
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      next: "Refresh the credentials with gcloud auth application-default login, or set GOOGLE_APPLICATION_CREDENTIALS to a current service account key.",
    })
  }
  throw error
}

/** `generateAccessToken`'s answer: `{accessToken, expireTime}`. */
async function impersonate(target: string, scopes: readonly string[], base: AdcToken, environment: Required<Pick<AdcEnvironment, "fetch" | "now">>, signal?: AbortSignal): Promise<AdcToken> {
  const url = `${IAM_CREDENTIALS_ENDPOINT}/projects/-/serviceAccounts/${encodeURIComponent(target)}:generateAccessToken`
  let response: Response
  try {
    response = await googleFetch(
      url,
      { method: "POST", headers: { Authorization: `Bearer ${base.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ scope: [...scopes], lifetime: "3600s" }), ...(signal ? { signal } : {}) },
      environment.fetch,
    )
  } catch {
    if (signal?.aborted) throw new ColabError("CANCELLED")
    throw new ColabError("UNAVAILABLE", "The service account impersonation request could not reach Google.")
  }
  if (response.status === 401) throw new ColabError("AUTH_REQUIRED", "Google rejected the credentials that would impersonate the service account.", { next: "Sign in again or refresh the ADC credentials." })
  if (response.status === 403) throw new ColabError("PERMISSION_DENIED", `Google refused to let these credentials impersonate ${target}; the caller needs roles/iam.serviceAccountTokenCreator on it.`)
  if (!response.ok) throw new ColabError("UNAVAILABLE", `Google's impersonation endpoint answered HTTP ${response.status}.`)
  const json = (await response.json().catch(() => undefined)) as unknown
  const access = isRecord(json) && typeof json["accessToken"] === "string" ? json["accessToken"] : ""
  const expire = isRecord(json) && typeof json["expireTime"] === "string" ? Date.parse(json["expireTime"]) : Number.NaN
  if (!access) throw new ColabError("UNAVAILABLE", "Google's impersonation endpoint returned no access token.")
  const expiresAt = Number.isFinite(expire) ? expire : environment.now() + 3600 * 1000
  return { token: access, expiresAt }
}

export interface AdcInput {
  /** The scope set the call needs. */
  readonly scopes: readonly string[]
  /** `accounts.<alias>.impersonate`. */
  readonly impersonate?: string
  readonly environment?: AdcEnvironment
  readonly signal?: AbortSignal
}

/** A token for an Enterprise account from ADC, impersonating when configured. */
export async function adcToken(input: AdcInput): Promise<AdcToken> {
  const environment = input.environment ?? {}
  const fetchImpl = environment.fetch ?? globalThis.fetch
  const now = environment.now ?? Date.now
  const resolved = { fetch: fetchImpl, now }
  const source = findAdcSource(environment)
  if (input.impersonate) {
    const base = await sourceToken(source, [SCOPES.cloudPlatform], resolved, input.signal)
    return await impersonate(input.impersonate, input.scopes, base, resolved, input.signal)
  }
  return await sourceToken(source, input.scopes, resolved, input.signal)
}

/**
 * Who an ADC credential belongs to, without a network call: a service account key names itself; an impersonated token
 * names its target; a gcloud user credential and the metadata server say nothing here.
 */
export function adcIdentity(input: { readonly impersonate?: string; readonly environment?: AdcEnvironment }): { readonly email: string; readonly verified: boolean } | undefined {
  if (input.impersonate) return { email: input.impersonate, verified: true }
  const source = findAdcSource(input.environment ?? {})
  return source.type === "service_account" ? { email: source.client_email, verified: true } : undefined
}
