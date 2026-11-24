// H10 in a real embedded host: the built plugin registers `colab-<alias>` as an OAuth integration, `/connect` shows its
// form with both levels and the exact scope URLs, and `/colab-doctor` is registered. No request leaves the machine.
import { afterAll, describe, expect, test } from "bun:test"
import { cleanup, startHost } from "./harness.js"

afterAll(cleanup)

const scopes = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/colaboratory",
  "https://www.googleapis.com/auth/colaboratory.readonly",
  "https://www.googleapis.com/auth/drive.file",
]

describe("the Colab sign-in in a host", () => {
  test("H10 — colab-default registers as an OAuth integration, its form shows the levels and scopes, and /colab-doctor is a command", async () => {
    const host = await startHost()
    try {
      const listed = await host.client.integration.list({ location: host.location })
      const integration = listed.data.find((item) => item.id === "colab-default")
      expect(integration).toBeDefined()
      expect(integration!.name).toBe("Colab")

      const { data } = await host.client.integration.get({ integrationID: "colab-default", location: host.location })
      expect(data.name).toBe("Colab")
      const method = data.methods.find((item) => item.type === "oauth")
      expect(method).toBeDefined()
      expect(method).toMatchObject({ id: "google", type: "oauth", label: "Sign in with Google" })

      const form = (method as { form?: { key: string; hidden?: boolean; options?: { value: string; description?: string }[] }[] }).form ?? []
      expect(form.map((field) => field.key)).toEqual(["clientId", "clientSecret", "clientJson", "access", "confirmWrite", "redirectUri", "callbackPort"])
      const access = form.find((field) => field.key === "access")!
      expect(access.options!.map((option) => option.value)).toEqual(["read", "write"])
      for (const scope of scopes.filter((scope) => scope !== "https://www.googleapis.com/auth/colaboratory.readonly")) expect(access.options![1]!.description).toContain(scope)
      expect(access.options![0]!.description).toContain("https://www.googleapis.com/auth/colaboratory.readonly")
      expect(access.options![1]!.description).toContain("https://www.googleapis.com/auth/colaboratory")
      expect(form.find((field) => field.key === "clientJson")!.hidden).toBe(true)

      const commands = await host.client.command.list({ location: host.location })
      expect(commands.data.map((command) => command.name)).toContain("colab-doctor")
    } finally {
      await host.close()
    }
  }, 120_000)
})
