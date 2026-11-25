// §15.1 auth: the `Auth` port per mode — the interactive credential and its local scope check, refresh and reporting,
// ADC's refusal and opt-in, token mode, identity and scopes — and no token or secret in an error.
import { describe, expect, it } from "vitest"
import { createAuth } from "../../src/provider/auth/index.js"
import { SCOPES } from "../../src/provider/auth/scopes.js"
import { loadOptions } from "../../src/options.js"
import { FakeClock } from "../fakes/index.js"
import { FakeAuthHost } from "../fakes/auth-host.js"
import { FakeHttp, storedCredential, tokenResponse } from "../fakes/auth-http.js"
import { invented } from "../support/invented.js"

const NOW = new Date("2026-11-17T09:00:00.000Z")
const clientId = "123456789012-colabtest.apps.googleusercontent.com"
const clientSecret = invented("GOCSPX-", "test-client-secret")

function setup(raw: unknown = {}, host = new FakeAuthHost(), http = new FakeHttp(), extra: { env?: NodeJS.ProcessEnv; readFile?: (path: string) => string } = {}) {
  const options = loadOptions(raw)
  const clock = new FakeClock(NOW)
  const auth = createAuth({ options, clock, host, fetch: http.fetch, env: extra.env ?? {}, ...(extra.readFile ? { readFile: extra.readFile } : {}) })
  return { options, clock, host, http, auth }
}

const signal = () => new AbortController().signal

describe("the Auth port (design §4, src/ports.ts)", () => {
  it("§15.1 auth — an interactive account's token is the host credential's, with no Google call", async () => {
    const { host, http, auth } = setup()
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), accessToken: invented("ya29.", "stored") }))
    await expect(auth.token("default", [SCOPES.colaboratory], signal())).resolves.toBe(invented("ya29.", "stored"))
    expect(http.calls).toHaveLength(0)
    await expect(auth.scopes("default")).resolves.toContain(SCOPES.colaboratory)
  })

  it("§15.1 auth — the local scope check refuses AUTH_SCOPE_MISSING and never calls Google", async () => {
    const { host, http, auth } = setup()
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), access: "read", requested: [], granted: [SCOPES.openid, SCOPES.email, SCOPES.colaboratoryReadonly] }))
    await expect(auth.token("default", [SCOPES.colaboratory], signal())).rejects.toThrow(/^AUTH_SCOPE_MISSING: .*colaboratory, and Google was not called/)
    expect(http.calls).toHaveLength(0)
    // The read-only scope is enough for a read, and full colaboratory covers it too.
    await expect(auth.token("default", [SCOPES.colaboratoryReadonly], signal())).resolves.toBe(invented("ya29.", "test-access-token"))
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), granted: [SCOPES.colaboratory] }))
    await expect(auth.token("default", [SCOPES.colaboratoryReadonly], signal())).resolves.toBe(invented("ya29.", "test-access-token"))
  })

  it("§15.1 auth — a read-only account is never handed a token for the write scope, even with a wider stored grant", async () => {
    const { host, auth } = setup({ accounts: { home: {} } })
    host.credentials.set("colab-home", storedCredential({ now: NOW.getTime(), granted: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile] }))
    await expect(auth.token("home", [SCOPES.colaboratory], signal())).rejects.toMatchObject({ code: "AUTH_SCOPE_MISSING" })
    await expect(auth.token("home", [SCOPES.colaboratoryReadonly], signal())).resolves.toBe(invented("ya29.", "test-access-token"))
  })

  it("§15.1 auth — no connection is AUTH_REQUIRED with /connect as the next step, and a scope-less record is refused", async () => {
    const { host, auth } = setup()
    await expect(auth.token("default", [], signal())).rejects.toMatchObject({ code: "AUTH_REQUIRED", next: expect.stringContaining("/connect") })
    host.credentials.set("colab", storedCredential({ now: NOW.getTime() }))
    ;(host.credentials.get("colab") as { metadata?: unknown }).metadata = { clientId }
    await expect(auth.token("default", [], signal())).rejects.toThrow(/^AUTH_REQUIRED: .*no scope record/)
    await expect(auth.identity("default", signal())).resolves.toBeUndefined()
  })

  it("§15.1 auth — an expiring credential is refreshed with the stored client, cached, and Google's new scopes follow", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, tokenResponse({ access: invented("ya29.", "refreshed"), expiresIn: 3600, scopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory] }))
    const { host, auth } = setup({}, new FakeAuthHost(), http)
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), expiresInMs: -1_000, accessToken: invented("ya29.", "old"), granted: [SCOPES.colaboratory] }))
    await expect(auth.token("default", [SCOPES.colaboratory], signal())).resolves.toBe(invented("ya29.", "refreshed"))
    await expect(auth.token("default", [SCOPES.colaboratory], signal())).resolves.toBe(invented("ya29.", "refreshed"))
    expect(http.calls).toHaveLength(1)
    expect(new URLSearchParams(http.calls[0]!.body).get("client_secret")).toBe(clientSecret)
  })

  it("§15.1 auth — a refresh Google refuses is AUTH_REQUIRED, with the host told the sign-in is needed and no secret in the error", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 400, { error: "invalid_grant", error_description: `revoked ${clientSecret}` })
    const { host, auth } = setup({}, new FakeAuthHost(), http)
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), expiresInMs: -1_000 }))
    const failure = await auth.token("default", [], signal()).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED" })
    expect(String((failure as Error).message)).not.toContain(clientSecret)
    expect(String((failure as Error).message)).not.toContain("1//test-refresh-token")
    expect(host.reports).toHaveLength(1)
    expect(host.reports[0]!.integrationID).toBe("colab")
  })

  it("§15.1 auth — identity comes from the ID token's stored claims, and scopes from the stored grant", async () => {
    const { host, auth } = setup()
    host.credentials.set("colab", storedCredential({ now: NOW.getTime(), email: "person@example.com", verified: false }))
    await expect(auth.identity("default", signal())).resolves.toEqual({ email: "person@example.com", verified: false })
    await expect(auth.scopes("default")).resolves.toEqual([SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile])
    await expect(auth.token("nope", [], signal())).rejects.toThrow(/^ACCOUNT_UNKNOWN: /)
  })

  it("§15.1 auth — an Enterprise account without a project or region is PROJECT_REQUIRED before any request", async () => {
    const http = new FakeHttp()
    const { auth } = setup({ accounts: { work: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN" } } }, new FakeAuthHost(), http, { env: { COLAB_TOKEN: invented("ya29.", "from-env") } })
    await expect(auth.token("work", [SCOPES.cloudPlatform], signal())).rejects.toThrow(/^PROJECT_REQUIRED: .*project/)
    expect(http.calls).toHaveLength(0)
  })

  it("§15.1 auth — ADC is refused under a managed host unless allowAdcInHost, and accepted when it is set", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, { access_token: invented("ya29.", "adc"), expires_in: 3600, token_type: "Bearer" })
    const key = JSON.stringify({ type: "service_account", client_email: "runner@example-project.iam.gserviceaccount.com", private_key: ["-----BEGIN", "PRIVATE KEY-----", "not-a-real-key", "-----END", "PRIVATE KEY-----"].join("\n") })
    const managed = { OPENCODE_DISABLE_PROJECT_CONFIG: "1", GOOGLE_APPLICATION_CREDENTIALS: "/keys/sa.json" }
    const raw = { accounts: { work: { backend: "enterprise", mode: "adc", project: "p", region: "us-central1" } } }
    const refused = setup(raw, new FakeAuthHost(), http, { env: managed, readFile: () => key })
    await expect(refused.auth.token("work", [SCOPES.cloudPlatform], signal())).rejects.toMatchObject({ code: "ADC_REFUSED" })
    const allowed = setup({ ...raw, allowAdcInHost: true }, new FakeAuthHost(), http, { env: managed, readFile: () => key })
    await expect(allowed.auth.token("work", [SCOPES.cloudPlatform], signal())).rejects.toMatchObject({ code: "ADC_UNAVAILABLE" }) // the key cannot sign: refused, never sent
    expect(http.calls).toHaveLength(0)
  })

  it("§15.1 auth — token mode reads tokenEnv, has no identity, and names a missing variable without printing a value", async () => {
    const { auth } = setup(
      { accounts: { work: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN", project: "p", region: "us-central1" } } },
      new FakeAuthHost(),
      new FakeHttp(),
      { env: { COLAB_TOKEN: invented("ya29.", "from-env") } },
    )
    await expect(auth.token("work", [SCOPES.cloudPlatform], signal())).resolves.toBe(invented("ya29.", "from-env"))
    await expect(auth.identity("work", signal())).resolves.toBeUndefined()
    await expect(auth.scopes("work")).resolves.toEqual([])
    const missing = setup(
      { accounts: { work: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN", project: "p", region: "us-central1" } } },
      new FakeAuthHost(),
      new FakeHttp(),
      { env: {} },
    )
    await expect(missing.auth.token("work", [], signal())).rejects.toThrow(/^AUTH_REQUIRED: .*COLAB_TOKEN/)
  })
})
