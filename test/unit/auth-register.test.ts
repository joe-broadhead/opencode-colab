// H10's unit half and §15.1 auth: the contract's accounts module registers one integration per alias with its Google
// method and form; the client precedence at authorize time; and disposing detaches the host bridge.
import { describe, expect, it } from "vitest"
import { hostFor } from "../../src/provider/auth/host.js"
import { SCOPES } from "../../src/provider/auth/scopes.js"
import { loadOptions } from "../../src/options.js"
import { manifest } from "../../src/manifest.js"
import { registerColabAccounts } from "../../src/accounts.js"
import { FakeClock } from "../fakes/index.js"
import { FakeAuthContext, FakeAuthHost } from "../fakes/auth-host.js"
import { FakeHttp, storedCredential } from "../fakes/auth-http.js"
import { invented } from "../support/invented.js"

const NOW = new Date("2026-11-17T09:00:00.000Z")
const clientId = "123456789012-colabtest.apps.googleusercontent.com"
const clientSecret = invented("GOCSPX-", "test-client-secret")

async function registered(raw: unknown, host = new FakeAuthHost(), http = new FakeHttp()) {
  const ctx = new FakeAuthContext(host)
  const options = loadOptions(raw)
  const result = await registerColabAccounts(ctx as never, { manifest, rawOptions: raw as Record<string, unknown>, options, host })
  return { ctx, options, result, host, http }
}

/** Abandon a started sign-in by completing its callback with a wrong state; the listener then closes. */
async function abandon(url: string): Promise<void> {
  const redirect = new URL(url).searchParams.get("redirect_uri")!
  await fetch(`${redirect}/?state=wrong&code=x`)
}

describe("the integrations (H10, design §4, §14)", () => {
  it("one interactive account registers the colab integration with the Google method and its form", async () => {
    const { ctx, result } = await registered({})
    try {
      expect([...ctx.integrations.keys()]).toEqual(["colab"])
      const entry = ctx.integrations.get("colab")!
      expect(entry.name).toBe("Colab")
      expect(entry.method).toMatchObject({ integrationID: "colab", method: { id: "google", type: "oauth", label: "Sign in with Google" } })
      const fields = entry.method!.method.form as { key: string; options?: { value: string; description?: string }[] }[]
      expect(fields.map((field) => field.key)).toEqual(["clientId", "clientSecret", "clientJson", "access", "confirmWrite", "redirectUri", "callbackPort"])
      expect(fields.find((field) => field.key === "access")!.options!.map((option) => option.value)).toEqual(["read", "write"])
      expect(fields.find((field) => field.key === "access")!.options![1]!.description).toContain(SCOPES.colaboratory)
    } finally {
      await result.detach()
    }
  })

  it("several interactive accounts are named per alias, and a headless account has no auth method", async () => {
    const { ctx, result } = await registered({ accounts: { home: { access: "write" }, work: { backend: "enterprise", access: "write", project: "p", region: "r" }, ci: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN", project: "p", region: "r" } } })
    try {
      expect([...ctx.integrations.keys()].sort()).toEqual(["colab-ci", "colab-home", "colab-work"])
      expect(ctx.integrations.get("colab-home")!.name).toBe("Colab (home)")
      expect(ctx.integrations.get("colab-work")!.name).toBe("Colab (work)")
      expect(ctx.integrations.get("colab-ci")!.method).toBeUndefined()
    } finally {
      await result.detach()
    }
  })

  it("§15.1 auth — authorize refuses with AUTH_CLIENT_REQUIRED before any listener, and an unacknowledged write with INPUT_INVALID", async () => {
    const { ctx, result } = await registered({})
    try {
      const authorize = ctx.integrations.get("colab")!.method!.authorize
      await expect(authorize({ access: "write", confirmWrite: true })).rejects.toMatchObject({ code: "AUTH_CLIENT_REQUIRED" })
      await expect(authorize({ access: "write" })).rejects.toMatchObject({ code: "INPUT_INVALID" })
    } finally {
      await result.detach()
    }
  })

  it("§15.1 auth — the plugin's configured client wins, and the sign-in's URL carries its ID and the level's scopes", async () => {
    const { ctx, result } = await registered({ oauthClient: `${clientId}:${clientSecret}` })
    try {
      const authorize = ctx.integrations.get("colab")!.method!.authorize
      const authorization = (await authorize({ access: "read" })) as { url: string }
      const url = new URL(authorization.url)
      expect(url.searchParams.get("client_id")).toBe(clientId)
      expect(url.searchParams.get("scope")).toBe([SCOPES.openid, SCOPES.email, SCOPES.colaboratoryReadonly, SCOPES.driveFile].join(" "))
      expect(url.searchParams.get("code_challenge_method")).toBe("S256")
      expect(authorization.url).not.toContain(clientSecret)
      await abandon(authorization.url)
    } finally {
      await result.detach()
    }
  })

  it("§15.1 auth — a previous pasted client is reused when the form leaves the client blank", async () => {
    const host = new FakeAuthHost()
    host.credentials.set("colab", storedCredential({ now: NOW.getTime() }))
    const { ctx, result } = await registered({}, host)
    try {
      const authorize = ctx.integrations.get("colab")!.method!.authorize
      const authorization = (await authorize({ access: "read" })) as { url: string }
      expect(new URL(authorization.url).searchParams.get("client_id")).toBe("123456789012-colabtest.apps.googleusercontent.com")
      await abandon(authorization.url)
    } finally {
      await result.detach()
    }
  })

  it("H10 — disposing detaches the host bridge, so a second host in the same process starts clean", async () => {
    const host = new FakeAuthHost()
    const { options, result } = await registered({}, host)
    expect(hostFor(options)).toBeDefined()
    await result.detach()
    expect(hostFor(options)).toBeUndefined()
  })
})
