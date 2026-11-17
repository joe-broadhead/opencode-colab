// H10's unit half and §15.1 auth: `registerAuth` registers one integration per interactive account with its form, the
// client precedence at authorize time, and `/colab-doctor`; disposing detaches the host bridge.
import { describe, expect, it } from "vitest"
import { DOCTOR_COMMAND, registerAuth } from "../../src/auth/index.js"
import { SCOPES } from "../../src/auth/scopes.js"
import { loadOptions } from "../../src/options.js"
import { FakeClock } from "../fakes/index.js"
import { FakeAuthContext, FakeAuthHost } from "../fakes/auth-host.js"
import { FakeHttp, storedCredential } from "../fakes/auth-http.js"

const NOW = new Date("2026-11-17T09:00:00.000Z")
const clientId = "123456789012-colabtest.apps.googleusercontent.com"
const clientSecret = "GOCSPX-test-client-secret"

async function registered(raw: unknown, host = new FakeAuthHost(), http = new FakeHttp()) {
  const ctx = new FakeAuthContext(host)
  const options = loadOptions(raw)
  const registration = await registerAuth(ctx, { options, clock: new FakeClock(NOW), fetch: http.fetch, env: {} })
  return { ctx, options, registration, host, http }
}

/** Abandon a started sign-in by completing its callback with a wrong state; the listener then closes. */
async function abandon(url: string): Promise<void> {
  const redirect = new URL(url).searchParams.get("redirect_uri")!
  await fetch(`${redirect}/?state=wrong&code=x`)
}

describe("the integrations and /colab-doctor (H10, design §4, §14)", () => {
  it("H10 — one interactive account registers colab-default with the Google method and its form", async () => {
    const { ctx, registration } = await registered({})
    try {
      expect([...ctx.integrations.keys()]).toEqual(["colab-default"])
      const entry = ctx.integrations.get("colab-default")!
      expect(entry.name).toBe("Colab")
      expect(entry.method).toMatchObject({ integrationID: "colab-default", method: { id: "google", type: "oauth", label: "Sign in with Google" } })
      const fields = entry.method!.method.form as { key: string; options?: { value: string; description?: string }[] }[]
      expect(fields.map((field) => field.key)).toEqual(["clientId", "clientSecret", "clientJson", "access", "confirmWrite", "redirectUri", "callbackPort"])
      expect(fields.find((field) => field.key === "access")!.options!.map((option) => option.value)).toEqual(["read", "write"])
      expect(fields.find((field) => field.key === "access")!.options![1]!.description).toContain(SCOPES.colaboratory)
      expect(ctx.commands.has(DOCTOR_COMMAND)).toBe(true)
    } finally {
      await registration.dispose()
    }
  })

  it("H10 — several interactive accounts are named per alias, and a headless account has no integration", async () => {
    const { ctx, registration } = await registered({ accounts: { home: { access: "write" }, work: { backend: "enterprise", access: "write", project: "p", region: "r" }, ci: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN", project: "p", region: "r" } } })
    try {
      expect([...ctx.integrations.keys()].sort()).toEqual(["colab-home", "colab-work"])
      expect(ctx.integrations.get("colab-home")!.name).toBe("Colab (home)")
      expect(ctx.integrations.get("colab-work")!.name).toBe("Colab (work)")
    } finally {
      await registration.dispose()
    }
  })

  it("§15.1 auth — authorize refuses with AUTH_CLIENT_REQUIRED before any listener, and an unacknowledged write with INPUT_INVALID", async () => {
    const { ctx, registration } = await registered({})
    try {
      const authorize = ctx.integrations.get("colab-default")!.method!.authorize
      await expect(authorize({ access: "write", confirmWrite: true })).rejects.toMatchObject({ code: "AUTH_CLIENT_REQUIRED" })
      await expect(authorize({ access: "write" })).rejects.toMatchObject({ code: "INPUT_INVALID" })
    } finally {
      await registration.dispose()
    }
  })

  it("§15.1 auth — the plugin's configured client wins, and the sign-in's URL carries its ID and the level's scopes", async () => {
    const { ctx, registration } = await registered({ oauthClient: `${clientId}:${clientSecret}` })
    try {
      const authorize = ctx.integrations.get("colab-default")!.method!.authorize
      const authorization = (await authorize({ access: "read" })) as { url: string }
      const url = new URL(authorization.url)
      expect(url.searchParams.get("client_id")).toBe(clientId)
      expect(url.searchParams.get("scope")).toBe([SCOPES.openid, SCOPES.email, SCOPES.colaboratoryReadonly, SCOPES.driveFile].join(" "))
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorization.url).not.toContain(clientSecret)
      await abandon(authorization.url)
    } finally {
      await registration.dispose()
    }
  })

  it("§15.1 auth — a previous pasted client is reused when the form leaves the client blank", async () => {
    const host = new FakeAuthHost()
    host.credentials.set("colab-default", storedCredential({ now: NOW.getTime() }))
    const { ctx, registration } = await registered({}, host)
    try {
      const authorize = ctx.integrations.get("colab-default")!.method!.authorize
      const authorization = (await authorize({ access: "read" })) as { url: string }
      expect(new URL(authorization.url).searchParams.get("client_id")).toBe("123456789012-colabtest.apps.googleusercontent.com")
      await abandon(authorization.url)
    } finally {
      await registration.dispose()
    }
  })

  it("H10 — disposing the registration detaches the host bridge, so a second host in the same process starts clean", async () => {
    const host = new FakeAuthHost()
    const { options, registration } = await registered({}, host)
    const { hostFor } = await import("../../src/auth/host.js")
    expect(hostFor(options)).toBeDefined()
    await registration.dispose()
    expect(hostFor(options)).toBeUndefined()
  })

  it("§14 — /colab-doctor posts one synthetic message, asserting colab.read before its one read", async () => {
    const http = new FakeHttp()
    http.on("colaboratory.googleapis.com", "/v1beta/runtimespecs", 200, {})
    const host = new FakeAuthHost()
    host.credentials.set("colab-default", storedCredential({ now: NOW.getTime() }))
    const { ctx, registration } = await registered({}, host, http)
    try {
      const definition = ctx.commands.get(DOCTOR_COMMAND)!
      expect(definition.description).toContain("Colab")
      await definition.execute({ sessionID: "ses_1", delivery: "steer" })
      expect(ctx.messages).toHaveLength(1)
      expect(ctx.messages[0]!.sessionID).toBe("ses_1")
      expect(ctx.messages[0]!.text).toContain("default (colab) runtimespecs.list: OK")
      expect(ctx.messages[0]!.text).toContain("runtime print(1): SKIPPED")
      expect(ctx.asserts).toContainEqual(expect.objectContaining({ sessionID: "ses_1", action: "colab.read", resources: ["default:colaboratory.runtimespecs.list"] }))
    } finally {
      await registration.dispose()
    }
  })
})
