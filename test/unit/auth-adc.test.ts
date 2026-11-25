// §15.1 auth: Application Default Credentials (files, gcloud's file, the metadata server), the service account's JWT
// bearer grant, impersonation, the managed-host refusal and the external-account refusal. All Google answers are
// scripted; the RSA key is generated in the test process.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { adcIdentity, adcToken, findAdcSource, gcloudAdcPath, isManagedHost, serviceAccountAssertion } from "../../src/provider/auth/adc.js"
import { SCOPES } from "../../src/provider/auth/scopes.js"
import type { ColabError } from "../../src/domain/errors.js"
import { FakeHttp, formBody, jsonResponse, serviceAccountKey } from "../fakes/auth-http.js"

const NOW = new Date("2026-11-17T09:00:00.000Z").getTime()
const key = serviceAccountKey()

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>
}

describe("Application Default Credentials (design §4)", () => {
  it("§15.1 auth — ADC reads GOOGLE_APPLICATION_CREDENTIALS, then gcloud's file, then the metadata server", () => {
    const files: Record<string, string> = {
      "/custom/sa.json": JSON.stringify(key),
      "/gcloud/application_default_credentials.json": JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "csecret", refresh_token: "1//rt" }),
    }
    const readFile = (path: string) => files[path]
    expect(findAdcSource({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/custom/sa.json" }, readFile })).toMatchObject({ type: "service_account", client_email: key.client_email })
    expect(findAdcSource({ env: { CLOUDSDK_CONFIG: "/gcloud" }, readFile })).toMatchObject({ type: "authorized_user" })
    expect(findAdcSource({ env: {}, readFile: () => undefined })).toEqual({ type: "metadata" })
    expect(gcloudAdcPath({ HOME: "/home/person" })).toMatch(/\.config\/gcloud\/application_default_credentials\.json$/)
    expect(gcloudAdcPath({ CLOUDSDK_CONFIG: "/gcloud" })).toBe("/gcloud/application_default_credentials.json")
  })

  it("§15.1 auth — a missing configured file is ADC_UNAVAILABLE, not a silent fall back to another source", () => {
    expect(() => findAdcSource({ env: { GOOGLE_APPLICATION_CREDENTIALS: "/missing.json" }, readFile: () => undefined })).toThrow(/^ADC_UNAVAILABLE: /)
  })

  it("§15.1 auth — a service account key signs the JWT bearer grant with Google's claims, and no key reaches a message", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, { access_token: "ya29.adc", expires_in: 3600, token_type: "Bearer" })
    const minted = await adcToken({ scopes: [SCOPES.cloudPlatform], environment: { env: { GOOGLE_APPLICATION_CREDENTIALS: "/key.json" }, readFile: () => JSON.stringify(key), fetch: http.fetch, now: () => NOW } })
    expect(minted.token).toBe("ya29.adc")
    expect(minted.expiresAt).toBe(NOW + 3600_000)
    const body = formBody(http.calls[0]!)
    expect(body.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer")
    const [header, claims] = body.get("assertion")!.split(".")
    expect(decode(header!)).toMatchObject({ alg: "RS256", typ: "JWT", kid: "test-key-id" })
    expect(decode(claims!)).toMatchObject({ iss: key.client_email, scope: SCOPES.cloudPlatform, aud: "https://oauth2.googleapis.com/token", iat: NOW / 1000, exp: NOW / 1000 + 3600 })
    expect(http.calls[0]!.body).not.toContain(key.private_key)
  })

  it("§15.1 auth — a gcloud user credential refreshes, and its failure never prints the refresh token", async () => {
    const http = new FakeHttp()
    http.route(
      (url) => url.host === "oauth2.googleapis.com" && url.pathname === "/token",
      () => jsonResponse(400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }),
    )
    const files = { "/gcloud/application_default_credentials.json": JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "csecret", refresh_token: "1//sensitive-refresh" }) }
    const failure = await adcToken({ scopes: [SCOPES.cloudPlatform], environment: { env: { CLOUDSDK_CONFIG: "/gcloud" }, readFile: (path) => files[path as keyof typeof files], fetch: http.fetch, now: () => NOW } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "AUTH_REQUIRED" })
    expect(String((failure as Error).message)).not.toContain("1//sensitive-refresh")
    expect((failure as ColabError).next).toContain("gcloud auth application-default login")
    expect(formBody(http.calls[0]!).get("grant_type")).toBe("refresh_token")
  })

  it("§15.1 auth — the metadata server is asked with Metadata-Flavor: Google, and its absence is ADC_UNAVAILABLE", async () => {
    const http = new FakeHttp()
    http.route(
      (url) => url.host === "metadata.google.internal",
      () => jsonResponse(200, { access_token: "ya29.metadata", expires_in: 1800, token_type: "Bearer" }),
    )
    const minted = await adcToken({ scopes: [SCOPES.cloudPlatform], environment: { env: {}, readFile: () => undefined, fetch: http.fetch, now: () => NOW } })
    expect(minted).toEqual({ token: "ya29.metadata", expiresAt: NOW + 1800_000 })
    expect(http.calls[0]!.headers["metadata-flavor"]).toBe("Google")
    http.calls.length = 0
    const offline = new FakeHttp()
    await expect(adcToken({ scopes: [SCOPES.cloudPlatform], environment: { env: {}, readFile: () => undefined, fetch: offline.fetch, now: () => NOW } })).rejects.toThrow(/^ADC_UNAVAILABLE: No Application Default Credentials/)
    expect(offline.calls.every((call) => new URL(call.url).host === "metadata.google.internal")).toBe(true)
  })

  it("§15.1 auth — impersonation asks generateAccessToken for the target with scope and lifetime, and reads accessToken/expireTime", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, { access_token: "ya29.caller", expires_in: 3600, token_type: "Bearer" })
    http.route(
      (url) => url.host === "iamcredentials.googleapis.com" && url.pathname === "/v1/projects/-/serviceAccounts/runner%40example-project.iam.gserviceaccount.com:generateAccessToken",
      () => jsonResponse(200, { accessToken: "ya29.impersonated", expireTime: "2026-11-17T10:00:00Z" }),
    )
    const minted = await adcToken({
      scopes: [SCOPES.cloudPlatform],
      impersonate: "runner@example-project.iam.gserviceaccount.com",
      environment: { env: { GOOGLE_APPLICATION_CREDENTIALS: "/key.json" }, readFile: () => JSON.stringify(key), fetch: http.fetch, now: () => NOW },
    })
    expect(minted.token).toBe("ya29.impersonated")
    expect(minted.expiresAt).toBe(Date.parse("2026-11-17T10:00:00Z"))
    const call = http.calls[1]!
    expect(call.headers["authorization"]).toBe("Bearer ya29.caller")
    expect(JSON.parse(call.body)).toEqual({ scope: [SCOPES.cloudPlatform], lifetime: "3600s" })
    expect(adcIdentity({ impersonate: "runner@example-project.iam.gserviceaccount.com" })).toEqual({ email: "runner@example-project.iam.gserviceaccount.com", verified: true })
  })

  it("§15.1 auth — an impersonation refusal is PERMISSION_DENIED naming the role, and no token is minted", async () => {
    const http = new FakeHttp()
    http.on("oauth2.googleapis.com", "/token", 200, { access_token: "ya29.caller", expires_in: 3600, token_type: "Bearer" })
    http.route(
      (url) => url.host === "iamcredentials.googleapis.com",
      () => jsonResponse(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }),
    )
    const failure = await adcToken({
      scopes: [SCOPES.cloudPlatform],
      impersonate: "runner@example-project.iam.gserviceaccount.com",
      environment: { env: { GOOGLE_APPLICATION_CREDENTIALS: "/key.json" }, readFile: () => JSON.stringify(key), fetch: http.fetch, now: () => NOW },
    }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "PERMISSION_DENIED" })
    expect(String((failure as Error).message)).toContain("roles/iam.serviceAccountTokenCreator")
  })

  it("§15.1 auth — a Workload Identity Federation credential file is refused by name (TODO L3)", async () => {
    const file = JSON.stringify({ type: "external_account", audience: "//iam.googleapis.com/projects/1/locations/global/workloadIdentityPools/p/providers/x", subject_token_type: "urn:ietf:params:oauth:token-type:jwt", token_url: "https://sts.googleapis.com/v1/token" })
    const failure = await adcToken({ scopes: [SCOPES.cloudPlatform], environment: { env: { GOOGLE_APPLICATION_CREDENTIALS: "/wif.json" }, readFile: () => file, fetch: new FakeHttp().fetch, now: () => NOW } }).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "ADC_UNAVAILABLE" })
    expect(String((failure as Error).message)).toContain("Workforce and Workload Identity Federation")
  })

  it("§15.1 auth — a managed host is recognised by the engine's own project-config variables", () => {
    expect(isManagedHost({ OPENCODE_DISABLE_PROJECT_CONFIG: "1" })).toBe(true)
    expect(isManagedHost({ OPENCODE_CONFIG_PROJECT_DISABLE: "1" })).toBe(true)
    expect(isManagedHost({})).toBe(false)
  })

  it("§15.1 auth — the signed assertion's input is the base64url header and claims, and its signature is not the key", () => {
    const assertion = serviceAccountAssertion({ type: "service_account", client_email: "a@b.iam.gserviceaccount.com", private_key: key.private_key, private_key_id: "kid" }, [SCOPES.cloudPlatform], NOW)
    const [header, claims, signature] = assertion.split(".")
    expect(decode(header!)).toEqual({ alg: "RS256", typ: "JWT", kid: "kid" })
    expect(decode(claims!)["scope"]).toBe(SCOPES.cloudPlatform)
    expect(signature!.length).toBeGreaterThan(100)
    expect(createHash("sha256").update(`${header}.${claims}`).digest("base64url")).not.toBe(signature)
  })
})
