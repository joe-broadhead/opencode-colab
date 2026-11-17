/**
 * Google's OAuth 2.0 flow for a desktop client: PKCE (S256), a random `state`, a loopback listener (or the relay a host
 * supplies), the code exchange, refresh, and the ID token's claims (design §4).
 *
 * Shapes, each from Google's documentation:
 * - Authorization and token endpoints, the code exchange (`grant_type=authorization_code`, `code_verifier`,
 *   `redirect_uri`), the refresh (`grant_type=refresh_token`), and the response fields `access_token`, `expires_in`,
 *   `refresh_token`, `scope`, `id_token`: "OAuth 2.0 for desktop apps"
 *   (https://developers.google.com/identity/protocols/oauth2/native-app).
 * - A refresh that fails is `400 {"error":"invalid_grant"}`; Google says to authenticate again. Workspace session
 *   control (https://support.google.com/a/answer/9368756) makes a cloud-platform refresh fail that way with a
 *   reauthentication subtype; the recorded shape is `"error_subtype":"invalid_rapt"` with
 *   `"error_description":"reauth related error (invalid_rapt)"` (TODO(L3): confirm the live shape), which maps to
 *   AUTH_REQUIRED with `reason: "session-control"` (design §4, M6).
 * - ID token claims `iss`, `aud`, `exp`, `email`, `email_verified` (Google's OpenID Connect page,
 *   https://developers.google.com/identity/openid-connect/openid-connect). The ID token comes straight from Google's
 *   token endpoint over HTTPS, and the claims are still checked against the client ID, the issuer and the clock.
 *
 * Every request goes through `googleFetch`, which refuses any URL outside the allow-list below; no message, page or error
 * contains the client secret, an authorization code, a verifier, or a token.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { ColabError } from "../domain/errors.js"
import { redact, withoutSecret } from "../redact.js"
import { buildAuthorizeUrl, createPkce, createState, GOOGLE_METHOD_ID, TOKEN_ENDPOINT } from "./pkce.js"
import type { ClientChoice } from "./client.js"
import type { SignInLevel } from "./scopes.js"
import { readSignIn, signInClient, signInMetadata, type IdentityClaims } from "./credential.js"
import type { Redirect } from "./redirect.js"

/** The hosts the auth module may contact: Google's endpoints, and the ADC metadata server for metadata mode only. */
export const ALLOWED_ORIGINS: readonly string[] = [
  "https://oauth2.googleapis.com",
  "https://iamcredentials.googleapis.com",
  "https://colaboratory.googleapis.com",
  "https://aiplatform.googleapis.com",
  "https://storage.googleapis.com",
]

const METADATA_HOSTS: readonly string[] = ["http://169.254.169.254", "http://metadata.google.internal"]

export function isAllowedEndpoint(value: string, metadata = false): boolean {
  try {
    const url = new URL(value)
    if (metadata) return METADATA_HOSTS.includes(url.origin)
    return url.protocol === "https:" && ALLOWED_ORIGINS.includes(url.origin)
  } catch {
    return false
  }
}

/** Refuses a URL the auth module must not contact. A failure is a bug in this module, never a person's input. */
export function assertEndpoint(value: string, metadata = false): void {
  if (!isAllowedEndpoint(value, metadata)) {
    throw new ColabError("UNAVAILABLE", "The sign-in tried to contact a host that is not a Google endpoint, so the request was not sent.", {
      next: "Report this as a bug in the plugin; no request left the machine.",
    })
  }
}

/** `fetch`, but only to an allowed endpoint, never following a redirect, with a timeout. */
export async function googleFetch(
  url: string,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
  options: { readonly metadata?: boolean; readonly timeoutMs?: number } = {},
): Promise<Response> {
  assertEndpoint(url, options.metadata === true)
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetchImpl(url, { ...init, signal, redirect: "error" })
}

export interface OAuthCredential {
  readonly type: "oauth"
  readonly methodID: string
  readonly refresh: string
  readonly access: string
  /** Milliseconds since the epoch, as OpenCode's credential stores it. */
  readonly expires: number
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface GoogleAuthOptions {
  readonly authorizeEndpoint?: string
  readonly tokenEndpoint?: string
  readonly timeoutMs?: number
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => number
}

const retryAfterSeconds = (response: Response): number | undefined => {
  const header = response.headers.get("retry-after")
  if (!header) return undefined
  const seconds = Number(header.trim())
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(86_400, Math.ceil(seconds)) : undefined
}

/** Google's token error as the plugin's code (design §12). Never echoes a secret, a code, a verifier or a token. */
export function tokenFailure(status: number, json: Readonly<Record<string, unknown>>, retryAfterSec?: number): ColabError {
  const error = typeof json["error"] === "string" ? json["error"] : ""
  const description = typeof json["error_description"] === "string" ? json["error_description"] : ""
  const subtype = typeof json["error_subtype"] === "string" ? json["error_subtype"] : ""
  const sessionControl = subtype === "invalid_rapt" || /reauth related error|invalid_rapt/i.test(description)
  if (error === "invalid_grant") {
    if (sessionControl) {
      return new ColabError(
        "AUTH_REQUIRED",
        "Google requires a fresh sign-in for this account: a Workspace session-control policy limits how long a Cloud session lasts, and the grant expired.",
        { reason: "session-control", next: "Sign in again with /connect; the Workspace administrator can exempt this client as a trusted app so it is not cut short." },
      )
    }
    return new ColabError("AUTH_REQUIRED", "Google rejected the stored sign-in: the grant expired or was revoked.", { next: "Run /connect and sign in again." })
  }
  if (error === "invalid_client" || error === "deleted_client" || error === "disabled_client") {
    return new ColabError("AUTH_CLIENT_REQUIRED", "Google refused the OAuth client of this sign-in: it was deleted, disabled, or does not match.", {
      next: "Enter a current Desktop app client in /connect, or update oauthClient.",
    })
  }
  if (error === "invalid_scope" || error === "access_denied") {
    return new ColabError("AUTH_SCOPE_MISSING", "Google refused one of the scopes this sign-in asked for.", { next: "Sign in again and approve every scope on Google's consent screen." })
  }
  if (error === "admin_policy_enforced" || error === "org_internal") {
    return new ColabError("AUTH_REQUIRED", "A Google Workspace policy blocks this client or the requested scopes for this account.", {
      next: "Ask the Workspace administrator to allow this OAuth client, then sign in again.",
    })
  }
  if (status === 401) return new ColabError("AUTH_REQUIRED")
  if (status === 403) return new ColabError("PERMISSION_DENIED")
  if (status === 429) return new ColabError("RATE_LIMITED", undefined, retryAfterSec !== undefined ? { retryAfterSec } : {})
  if (status >= 500) return new ColabError("UNAVAILABLE", "Google's token endpoint is unavailable right now.")
  const named = error ? ` (${redact(error)})` : ""
  return new ColabError("UNAVAILABLE", `Google's token endpoint refused the request${named}.`, { next: "Try again; if it persists, sign in again with /connect." })
}

export interface TokenSet {
  readonly access: string
  readonly refresh?: string
  readonly expiresIn: number
  readonly scopes?: string[]
  /** Base64url identity claims, when the response carried one. */
  readonly idToken?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const grantedScopes = (value: unknown): string[] | undefined => {
  if (typeof value !== "string" || !value.trim()) return undefined
  return [...new Set(value.trim().split(/\s+/))]
}

/** POST the token endpoint and read Google's fields; no retry of its own (the caller owns retries). */
export async function requestTokens(
  endpoint: string,
  body: URLSearchParams,
  fetchImpl: typeof globalThis.fetch,
  secrets: readonly string[],
  signal?: AbortSignal,
): Promise<TokenSet> {
  let response: Response
  try {
    response = await googleFetch(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        ...(signal ? { signal } : {}),
      },
      fetchImpl,
    )
  } catch (error) {
    if (signal?.aborted) throw new ColabError("CANCELLED")
    const reason = secrets.reduce((text, secret) => withoutSecret(text, secret), redact(error instanceof Error ? error.message : "the request failed"))
    throw new ColabError("UNAVAILABLE", `Google's token endpoint could not be reached (${reason}).`)
  }
  let text = ""
  try {
    text = await response.text()
  } catch {
    /* an error response's body is optional */
  }
  let json: Record<string, unknown> = {}
  if (text.trim()) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (isRecord(parsed)) json = parsed
    } catch {
      if (response.ok) throw new ColabError("UNAVAILABLE", "Google's token endpoint returned an answer that is not JSON.")
    }
  }
  if (!response.ok) throw tokenFailure(response.status, json, retryAfterSeconds(response))
  const access = typeof json["access_token"] === "string" ? json["access_token"] : ""
  if (!access) throw new ColabError("AUTH_REQUIRED", "Google's token endpoint returned no access token.", { next: "Sign in again with /connect." })
  const rawExpires = typeof json["expires_in"] === "number" ? json["expires_in"] : Number(json["expires_in"])
  const expiresIn = Number.isFinite(rawExpires) && rawExpires > 0 ? Math.floor(rawExpires) : 3600
  const refresh = typeof json["refresh_token"] === "string" && json["refresh_token"] ? json["refresh_token"] : undefined
  const idToken = typeof json["id_token"] === "string" && json["id_token"] ? json["id_token"] : undefined
  return { access, ...(refresh ? { refresh } : {}), expiresIn, scopes: grantedScopes(json["scope"]), ...(idToken ? { idToken } : {}) }
}

function base64urlJson(part: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The identity claims of a Google ID token, checked against the client and the clock (issuer, audience, expiry). The
 * token arrives directly from Google's token endpoint over HTTPS, so the signature is not re-verified; the claims are
 * still refused unless they name this client and have not expired.
 */
export function identityFromIdToken(idToken: string, clientId: string, now: number): IdentityClaims | undefined {
  const parts = idToken.split(".")
  if (parts.length !== 3) return undefined
  const claims = base64urlJson(parts[1]!)
  if (!claims) return undefined
  const issuer = claims["iss"]
  if (issuer !== "https://accounts.google.com" && issuer !== "accounts.google.com") return undefined
  if (claims["aud"] !== clientId) return undefined
  const exp = typeof claims["exp"] === "number" ? claims["exp"] : Number(claims["exp"])
  if (!Number.isFinite(exp) || exp * 1000 <= now) return undefined
  const email = typeof claims["email"] === "string" ? claims["email"] : undefined
  if (!email) return undefined
  return { email, verified: claims["email_verified"] === true || claims["email_verified"] === "true" }
}

export interface GoogleAuthorization {
  readonly url: string
  readonly instructions: string
  readonly expiresAt: number
  readonly mode: "auto"
  readonly callback: Promise<OAuthCredential>
}

export interface AuthorizeInput {
  readonly alias: string
  /** The integration's name, for the next step's wording. */
  readonly name: string
  readonly client: ClientChoice
  readonly access: SignInLevel
  /** Every scope the sign-in requests, identity scopes included. */
  readonly scopes: readonly string[]
  readonly redirect: Redirect
  readonly options?: GoogleAuthOptions
  /** Lets the caller stop waiting and close the listener, as a cancelled sign-in does. */
  readonly signal?: AbortSignal
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; background: Canvas; color: CanvasText; }
  main { max-width: 34rem; padding: 2rem; text-align: center; }
  h1 { font-size: 1.35rem; margin: 0 0 0.75rem; }
  p { margin: 0.5rem 0; color: color-mix(in srgb, CanvasText 78%, Canvas); }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1>${body}</main></body>
</html>`
}

function respond(response: ServerResponse, status: number, title: string, body: string): void {
  if (response.writableEnded) return
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "close",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  })
  response.end(page(title, body))
}

function stateMatches(actual: string, expected: string): boolean {
  const left = Buffer.from(actual)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function listenOnLoopback(server: Server, port: number): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const onError = (): void => {
      server.off("listening", onListening)
      reject(
        new ColabError("INPUT_INVALID", port ? `The sign-in could not listen on 127.0.0.1:${port}; another program may use that port.` : "The sign-in could not start its local callback server.", {
          next: port ? "Stop the program using that port, or unset callbackPort." : "Try again; if it persists, report it.",
        }),
      )
    }
    const onListening = (): void => {
      server.off("error", onError)
      const address = server.address()
      if (!address || typeof address === "string") {
        reject(new ColabError("INPUT_INVALID", "The sign-in could not determine the local callback port."))
        return
      }
      resolve(address.port)
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(port, "127.0.0.1")
  })
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      server.closeAllConnections?.()
      resolve()
    }, 500)
    timer.unref?.()
    server.close(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/** What the person sees beside the sign-in link: the account, the level, every scope, and the redirect hint. */
function instructions(alias: string, access: SignInLevel, scopes: readonly string[], fixedRedirect: boolean): string {
  const hint = fixedRedirect
    ? "If Google shows redirect_uri_mismatch, the client does not list this exact redirect URI."
    : "If Google shows redirect_uri_mismatch, the client is not a Desktop app."
  return [
    `Sign in to Google for Colab (${alias}) with ${access === "write" ? "read and write" : "read-only"} access.`,
    `Google will ask you to approve exactly these scopes: ${scopes.join(", ")}.`,
    hint,
  ].join(" ")
}

/**
 * Start a sign-in: listen on 127.0.0.1 (or the port the relay forwards to), build the authorization URL, and resolve
 * when Google's callback arrives with a code. Rejects on a bad state, an error from Google, a bad exchange, or the
 * timeout; every message is built here, never from Google's text.
 */
export async function authorizeGoogle(input: AuthorizeInput): Promise<GoogleAuthorization> {
  const { client } = input.client
  const options = input.options ?? {}
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000
  const scopes = [...input.scopes]
  const pkce = createPkce()
  const state = createState()

  let settle!: (credential: OAuthCredential) => void
  let fail!: (error: Error) => void
  const callback = new Promise<OAuthCredential>((resolve, reject) => {
    settle = resolve
    fail = reject
  })
  // A host may abandon a sign-in without awaiting the callback; that must not crash the process.
  void callback.catch(() => {})

  let finished = false
  let processing = false
  let timer: NodeJS.Timeout | undefined
  let redirectUri = input.redirect.uri

  const finish = async (error?: Error, credential?: OAuthCredential): Promise<void> => {
    if (finished) return
    finished = true
    if (timer) clearTimeout(timer)
    await closeServer(server)
    if (error) fail(error)
    else if (credential) settle(credential)
    else fail(new ColabError("AUTH_REQUIRED", "The sign-in ended without a credential.", { next: `Run /connect and choose ${input.name}.` }))
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      if (request.method !== "GET") {
        respond(response, 405, "Method not allowed", "<p>Use the sign-in link from OpenCode.</p>")
        return
      }
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
      if (!input.redirect.paths.includes(requestUrl.pathname)) {
        respond(response, 404, "Not found", "<p>This is not the OAuth callback.</p>")
        return
      }
      if (finished) {
        respond(response, 409, "Sign-in already finished", "<p>This sign-in attempt has already completed.</p>")
        return
      }
      const stateParam = requestUrl.searchParams.get("state") ?? ""
      const oauthError = requestUrl.searchParams.get("error")
      const code = requestUrl.searchParams.get("code")
      if (!stateParam && !oauthError && !code) {
        respond(response, 400, "Waiting for Google sign-in", "<p>Open the sign-in link from OpenCode.</p>")
        return
      }
      if (!stateMatches(stateParam, state)) {
        respond(response, 400, "Sign-in failed", "<p>The OAuth state did not match. Start the sign-in again.</p>")
        await finish(new ColabError("AUTH_REQUIRED", "The sign-in callback's OAuth state did not match, so it was refused.", { next: `Run /connect and choose ${input.name} again.` }))
        return
      }
      if (oauthError) {
        const named = /^[A-Za-z0-9_.-]{1,80}$/.test(oauthError) ? oauthError : "an error"
        respond(response, 400, "Sign-in failed", `<p>Google returned: ${escapeHtml(named)}.</p>`)
        const next = named === "access_denied" ? "Approve the consent screen to sign in." : `Run /connect and choose ${input.name} again.`
        await finish(new ColabError("AUTH_REQUIRED", `Google refused the sign-in (${named}).`, { next }))
        return
      }
      if (!code) {
        respond(response, 400, "Sign-in failed", "<p>The callback did not include an authorization code.</p>")
        await finish(new ColabError("AUTH_REQUIRED", "The sign-in callback carried no authorization code.", { next: `Run /connect and choose ${input.name} again.` }))
        return
      }
      if (processing) {
        respond(response, 409, "Sign-in already in progress", "<p>This sign-in attempt is already being completed.</p>")
        return
      }
      processing = true
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code,
          client_id: client.clientId,
          client_secret: client.clientSecret,
          redirect_uri: redirectUri,
          code_verifier: pkce.verifier,
        })
        const tokens = await requestTokens(tokenEndpoint, body, fetchImpl, [code, pkce.verifier, client.clientSecret])
        if (!tokens.refresh) {
          throw new ColabError("AUTH_REQUIRED", "Google did not return a refresh token, so the sign-in could not be kept.", {
            next: "Remove this app's access at https://myaccount.google.com/permissions, then sign in again.",
          })
        }
        const granted = tokens.scopes ?? scopes
        const identity = tokens.idToken ? identityFromIdToken(tokens.idToken, client.clientId, now()) : undefined
        const credential: OAuthCredential = {
          type: "oauth",
          methodID: GOOGLE_METHOD_ID,
          refresh: tokens.refresh,
          access: tokens.access,
          expires: Math.floor(now() + tokens.expiresIn * 1000),
          metadata: signInMetadata({ client: input.client, access: input.access, requestedScopes: scopes, grantedScopes: granted, ...(identity ? { identity } : {}) }) as unknown as Record<string, unknown>,
        }
        if (!finished) respond(response, 200, "Colab connected", "<p>Authentication is complete. You can close this window.</p>")
        await finish(undefined, credential)
      } catch (error) {
        if (!finished) respond(response, 500, "Sign-in failed", "<p>OpenCode could not complete the Google token exchange. Check the terminal for the next step.</p>")
        await finish(error instanceof ColabError ? error : new ColabError("UNAVAILABLE", "The sign-in's token exchange failed."))
      }
    } catch {
      if (!finished) respond(response, 500, "Sign-in failed", "<p>OpenCode could not process the local OAuth callback.</p>")
      await finish(new ColabError("UNAVAILABLE", "The sign-in callback could not be processed."))
    }
  }

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  try {
    const port = await listenOnLoopback(server, input.redirect.port)
    if (!redirectUri) redirectUri = `http://127.0.0.1:${port}`
  } catch (error) {
    await closeServer(server)
    throw error
  }

  server.on("error", () => {
    void finish(new ColabError("UNAVAILABLE", "The sign-in's local callback server stopped unexpectedly.", { next: `Run /connect and choose ${input.name} again.` }))
  })

  timer = setTimeout(() => {
    const minutes = Math.max(1, Math.round(timeoutMs / 60_000))
    void finish(new ColabError("AUTH_REQUIRED", `The sign-in timed out after ${minutes} minute${minutes === 1 ? "" : "s"}.`, { next: `Run /connect and choose ${input.name} again.` }))
  }, timeoutMs)
  timer.unref?.()

  if (input.signal) {
    const abort = () => void finish(new ColabError("CANCELLED"))
    if (input.signal.aborted) abort()
    else input.signal.addEventListener("abort", abort, { once: true })
  }

  let url: string
  try {
    url = buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      scopes,
      state,
      codeChallenge: pkce.challenge,
      ...(options.authorizeEndpoint ? { endpoint: options.authorizeEndpoint } : {}),
    })
  } catch (error) {
    await finish(error instanceof Error ? error : new ColabError("UNAVAILABLE", "The authorization URL could not be built."))
    throw error
  }

  return {
    url,
    instructions: instructions(input.alias, input.access, scopes, input.redirect.uri !== ""),
    expiresAt: now() + timeoutMs,
    mode: "auto",
    callback,
  }
}

/**
 * Refresh with the client the sign-in used, from the credential itself, so a later change of the configured client
 * does not break it. Google may report a changed grant; the stored scopes follow it, and the identity claims are kept.
 */
export async function refreshGoogle(input: {
  readonly alias: string
  readonly name: string
  readonly credential: OAuthCredential
  readonly options?: GoogleAuthOptions
  readonly signal?: AbortSignal
}): Promise<OAuthCredential> {
  const signIn = readSignIn(input.credential.metadata)
  if (!input.credential.refresh || !signIn) {
    throw new ColabError("AUTH_REQUIRED", `The Google sign-in for ${input.alias} has no refresh token or no scope record, so it cannot be renewed.`, {
      next: `Run /connect, choose ${input.name}, and sign in again.`,
    })
  }
  const options = input.options ?? {}
  const now = options.now ?? Date.now
  const fetchImpl = options.fetch ?? globalThis.fetch
  const tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT
  const { client } = signInClient(signIn)
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: input.credential.refresh, client_id: client.clientId, client_secret: client.clientSecret })
  const tokens = await requestTokens(tokenEndpoint, body, fetchImpl, [input.credential.refresh, input.credential.access, client.clientSecret], input.signal)
  const identity = tokens.idToken ? identityFromIdToken(tokens.idToken, client.clientId, now()) : signIn.identity
  return {
    type: "oauth",
    methodID: input.credential.methodID,
    refresh: tokens.refresh ?? input.credential.refresh,
    access: tokens.access,
    expires: Math.floor(now() + tokens.expiresIn * 1000),
    metadata: {
      ...signInMetadata({
        client: signInClient(signIn),
        access: signIn.access,
        requestedScopes: signIn.requestedScopes,
        grantedScopes: tokens.scopes ?? signIn.grantedScopes,
        ...(identity ? { identity } : {}),
      }),
    } as unknown as Record<string, unknown>,
  }
}
