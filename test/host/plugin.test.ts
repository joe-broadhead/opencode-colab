// The built plugin in an embedded OpenCode host. Nothing leaves the machine: close() fails the test if the host tried.
import { afterAll, describe, expect, test } from "bun:test"
import { defaultRules } from "../../src/permissions.js"
import { isStatus } from "../../src/rpc.js"
import { agentRules, cleanup, pluginState, startHost, status } from "./harness.js"

afterAll(cleanup)

const after = (rules: { action: string; resource: string; effect: string }[], length: number) => {
  const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
  return rules.slice(base + 1, base + 1 + length)
}

describe("the plugin in a host", () => {
  test("loads, inserts the default rules and answers status with no request off the machine", async () => {
    const host = await startHost()
    try {
      expect(await pluginState(host)).toEqual({ status: "active" })
      const rules = (await agentRules(host)).get("build") ?? []
      expect(after(rules, defaultRules("all").length)).toEqual(defaultRules("all"))
      const answer = await status(host)
      expect(isStatus(answer)).toBe(true)
      expect(answer).toMatchObject({ access: "all", accounts: [{ alias: "default", backend: "colab" }], tools: { registered: 0 }, unguardedAgents: [], nextStep: "Nothing to do." })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("at read-only, the namespace is denied", async () => {
    const host = await startHost({ options: { access: "read-only" } })
    try {
      const rules = (await agentRules(host)).get("build") ?? []
      expect(after(rules, defaultRules("read-only").length)).toEqual(defaultRules("read-only"))
      expect(rules).toContainEqual({ action: "colab.*", resource: "*", effect: "deny" })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("refuses an unknown option, and a host outside the range", async () => {
    const typo = await startHost({ options: { acess: "all" } })
    try {
      expect(await pluginState(typo)).toMatchObject({ status: "failed", error: expect.stringContaining("OPTIONS_INVALID") })
    } finally {
      await typo.close()
    }
    const old = await startHost({ version: "2.1.0" })
    try {
      expect(await pluginState(old)).toMatchObject({ status: "failed", error: expect.stringContaining("HOST_UNTESTED") })
    } finally {
      await old.close()
    }
  }, 240_000)
})
