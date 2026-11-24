// §15.1 auth: the desktop flow end to end on a loopback listener (or the host's relay), the code exchange's PKCE, the
// refresh, the session-control mapping, the ID token's claims, and the endpoint allow-list. No request leaves the
// machine: the token endpoint is a recording fake.
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import { authorizeGoogle, identityFromIdToken, isAllowedEndpoint, assertEndpoint, refreshGoogle, tokenFailure } from "../../src/auth/google.js"
import { resolveRedirect } from "../../src/auth/redirect.js"
import { SCOPES } from "../../src/auth/scopes.js"
import { desktopClient } from "../../src/auth/client.js"
import { readSignIn } from "../../src/auth/credential.js"
import { FakeHttp, formBody, idToken, storedCredential, tokenResponse } from "../fakes/auth-http.js"

const NOW = new Date("2026-11-17T09:00:00.000Z").getTime()
const clientId = "123456789012-colabtest.apps.googleusercontent.com"
const clientSecret = "GOCSPX-test-client-secret"
const client = desktopClient(clientId, clientSecret)!

function authorization(http: FakeHttp, overrides: Partial<Parameters<typeof authorizeGoogle>[0]> = {}) {
  return authorizeGoogle({
    alias: "default",
    name: "Colab",
    client: { client, source: "pasted" },
    access: "write",
    scopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile],
    redirect: { uri: "", port: 0, paths: ["/", "/callback"] },
    options: { fetch: http.fetch, now: () => NOW, timeoutMs: 5_000 },
    ...overrides,
  })
}

/** The redirect and state of a started sign-in, read from Google's URL. */
function started(url: string): { redirectUri: string; state: string; challenge: string } {
  const parsed = new URL(url)
  return { redirectUri: parsed.searchParams.get("redirect_uri")!, state: parsed.searchParams.get("state")!, challenge: parsed.searchParams.get("code_challenge")! }
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = address && typeof address !== "string" ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

describe("the Google sign-in flow (design §4)", () => {
  it("§15.1 auth — a loopback sign-in completes with PKCE, exchanges the code, and stores the grant and the ID token's identity", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, tokenResponse({ refresh: "1//new-refresh", idToken: idToken({ email: "person@example.com", clientId, now: NOW }) }))
    const flow = await authorization(http)
    const { redirectUri, state, challenge } = started(flow.url)
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(flow.instructions).toContain("read and write")
    expect(flow.instructions).toContain(SCOPES.colaboratory)

    const answer = await fetch(`${redirectUri}/?state=${encodeURIComponent(state)}&code=4%2Ftest-code`)
    expect(answer.status).toBe(200)
    const credential = await flow.callback

    const exchange = formBody(http.calls[0]!)
    expect(new URL(http.calls[0]!.url).origin).toBe("https://oauth2.googleapis.com")
    expect(exchange.get("grant_type")).toBe("authorization_code")
    expect(exchange.get("code")).toBe("4/test-code")
    expect(exchange.get("client_id")).toBe(clientId)
    expect(exchange.get("client_secret")).toBe(clientSecret)
    expect(exchange.get("redirect_uri")).toBe(redirectUri)
    const verifier = exchange.get("code_verifier")!
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(createHash("sha256").update(verifier).digest("base64url")).toBe(challenge)

    expect(credential).toMatchObject({ type: "oauth", methodID: "google", refresh: "1//new-refresh", access: "ya29.test-access-token", expires: NOW + 3600_000 })
    const signIn = readSignIn(credential.metadata)
    expect(signIn).toMatchObject({ access: "write", clientSource: "pasted", grantedScopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile], identity: { email: "person@example.com", verified: true } })
    expect(credential.refresh).toBe("1//new-refresh")
  })

  it("§15.1 auth — a callback whose state does not match is refused and produces no credential", async () => {
    const http = new FakeHttp()
    const flow = await authorization(http)
    const { redirectUri } = started(flow.url)
    const answer = await fetch(`${redirectUri}/?state=wrong&code=4%2Ftest-code`)
    expect(answer.status).toBe(400)
    await expect(flow.callback).rejects.toMatchObject({ code: "AUTH_REQUIRED" })
    expect(http.calls).toHaveLength(0)
  })

  it("§15.1 auth — Google's error callback is a refusal naming the error, never a credential", async () => {
    const http = new FakeHttp()
    const flow = await authorization(http)
    const { redirectUri, state } = started(flow.url)
    const answer = await fetch(`${redirectUri}/?state=${encodeURIComponent(state)}&error=access_denied`)
    expect(answer.status).toBe(400)
    await expect(flow.callback).rejects.toThrow(/access_denied/)
    expect(http.calls).toHaveLength(0)
  })

  it("L14 — the host's relay redirect (the host's sign-in) is used for the exchange and only its path is accepted", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, tokenResponse({ refresh: "1//relay" }))
    const port = await freePort()
    const redirect = resolveRedirect({ redirectUri: "https://host.example/oauth/return", callbackPort: port })
    const flow = await authorization(http, { redirect })
    const { state } = started(flow.url)
    const wrong = await fetch(`http://127.0.0.1:${port}/?state=${encodeURIComponent(state)}&code=x`)
    expect(wrong.status).toBe(404)
    const answer = await fetch(`http://127.0.0.1:${port}/oauth/return?state=${encodeURIComponent(state)}&code=4%2Frelay-code`)
    expect(answer.status).toBe(200)
    await flow.callback
    expect(formBody(http.calls[0]!).get("redirect_uri")).toBe("https://host.example/oauth/return")
  })

  it("§15.1 auth — a refresh uses the client stored with the sign-in, follows Google's new grant, and keeps the identity", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, tokenResponse({ access: "ya29.refreshed", expiresIn: 1800, scopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile] }))
    const credential = storedCredential({ now: NOW, email: "person@example.com", granted: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory] })
    const refreshed = await refreshGoogle({ alias: "default", name: "Colab", credential, options: { fetch: http.fetch, now: () => NOW } })
    const body = formBody(http.calls[0]!)
    expect(body.get("grant_type")).toBe("refresh_token")
    expect(body.get("refresh_token")).toBe("1//test-refresh-token")
    expect(body.get("client_id")).toBe(clientId)
    expect(body.get("client_secret")).toBe(clientSecret)
    expect(refreshed).toMatchObject({ access: "ya29.refreshed", refresh: "1//test-refresh-token", expires: NOW + 1800_000 })
    expect(readSignIn(refreshed.metadata)).toMatchObject({ grantedScopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile], identity: { email: "person@example.com" } })
  })

  it("L3 — session control maps invalid_grant with the reauth subtype to AUTH_REQUIRED reason session-control", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 400, { error: "invalid_grant", error_description: "reauth related error (invalid_rapt)", error_subtype: "invalid_rapt" })
    const credential = storedCredential({ now: NOW })
    const failure = await refreshGoogle({ alias: "default", name: "Colab", credential, options: { fetch: http.fetch, now: () => NOW } }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ColabError)
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED", reason: "session-control" })
    expect(String((failure as Error).message)).toContain("session-control")
    expect(String((failure as Error).message)).toContain("trusted app")
    expect(String((failure as Error).message)).not.toContain("1//test-refresh-token")
    expect(String((failure as Error).message)).not.toContain(clientSecret)
  })

  it("L4 — colaboratory.readonly is accepted for a read and is not a code-execution fence", async () => {
    const { missingScopes, SCOPES: scopes } = await import("../../src/auth/scopes.js")
    expect(missingScopes([scopes.colaboratoryReadonly], [scopes.colaboratoryReadonly])).toEqual([])
    // The scope is not a fence: the plugin's own classification is. A read grant therefore still runs code on a runtime
    // the plugin created; only creating or deleting a runtime needs the full scope (design §4, L4).
    expect(missingScopes([scopes.colaboratoryReadonly], [scopes.colaboratory])).toEqual(["colaboratory"])
  })

  it("§15.1 auth — a plain invalid_grant is AUTH_REQUIRED, an invalid client AUTH_CLIENT_REQUIRED, and a quota RATE_LIMITED", () => {
    expect(tokenFailure(400, { error: "invalid_grant" })).toMatchObject({ code: "AUTH_REQUIRED" })
    expect(tokenFailure(400, { error: "invalid_grant" }).reason).toBeUndefined()
    expect(tokenFailure(400, { error: "invalid_client" })).toMatchObject({ code: "AUTH_CLIENT_REQUIRED" })
    expect(tokenFailure(429, { error: "rate_limit_exceeded" }, 42)).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 42 })
    expect(tokenFailure(503, {})).toMatchObject({ code: "UNAVAILABLE" })
  })

  it("§15.1 auth — Google's error text is never copied into a failure, so a secret echoed back cannot escape", () => {
    const failure = tokenFailure(400, { error: "invalid_grant", error_description: `bad code ${clientSecret} and 1//test-refresh-token` })
    expect(failure.message).not.toContain(clientSecret)
    expect(failure.message).not.toContain("1//test-refresh-token")
  })

  it("§15.1 auth — ID token claims are checked against the issuer, the client and the clock", () => {
    expect(identityFromIdToken(idToken({ clientId, email: "a@example.com", now: NOW }), clientId, NOW)).toEqual({ email: "a@example.com", verified: true })
    expect(identityFromIdToken(idToken({ clientId, email: "a@example.com", emailVerified: false, now: NOW }), clientId, NOW)).toEqual({ email: "a@example.com", verified: false })
    expect(identityFromIdToken(idToken({ clientId: "another-client", now: NOW }), clientId, NOW)).toBeUndefined()
    expect(identityFromIdToken(idToken({ clientId, issuer: "https://evil.example", now: NOW }), clientId, NOW)).toBeUndefined()
    expect(identityFromIdToken(idToken({ clientId, expiresInSec: -10, now: NOW }), clientId, NOW)).toBeUndefined()
    expect(identityFromIdToken("not-a-jwt", clientId, NOW)).toBeUndefined()
  })

  it("§15.1 auth — the endpoint allow-list accepts only Google's hosts (and the metadata server for ADC)", () => {
    expect(isAllowedEndpoint("https://oauth2.googleapis.com/token")).toBe(true)
    expect(isAllowedEndpoint("https://colaboratory.googleapis.com/v1beta/runtimespecs")).toBe(true)
    expect(isAllowedEndpoint("https://evil.example/token")).toBe(false)
    expect(isAllowedEndpoint("http://oauth2.googleapis.com/token")).toBe(false)
    expect(isAllowedEndpoint("http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token", true)).toBe(true)
    expect(isAllowedEndpoint("https://metadata.google.internal/token", true)).toBe(false)
    expect(() => assertEndpoint("https://evil.example/token")).toThrow(/^UNAVAILABLE: /)
  })

  it("§15.1 auth — a sign-in with no answer times out and closes, rather than hanging", async () => {
    const http = new FakeHttp()
    const flow = await authorization(http, { options: { fetch: http.fetch, now: () => NOW, timeoutMs: 30 } })
    await expect(flow.callback).rejects.toMatchObject({ code: "AUTH_REQUIRED" })
    expect(http.calls).toHaveLength(0)
  })

  it("§15.1 auth — a token endpoint outside Google's hosts is refused before any request", async () => {
    const http = new FakeHttp()
    const flow = await authorization(http, { options: { fetch: http.fetch, now: () => NOW, tokenEndpoint: "https://evil.example/token" } })
    const { redirectUri, state } = started(flow.url)
    await fetch(`${redirectUri}/?state=${encodeURIComponent(state)}&code=4%2Fx`)
    await expect(flow.callback).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(http.calls).toHaveLength(0)
  })
})
