// The built bundle in the real embedded OpenCode 2.4.1 host: the contract's own harness, with HOME and the XDG roots
// isolated first so no real OpenCode state is read or written.
import "./isolate.js"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"
import { createHost } from "@we-the-rebel-alliance/plugin-contract/kit"
import { manifest } from "../../src/manifest.js"

const REPO = fileURLToPath(new URL("../../", import.meta.url))

describe("the built plugin in the real host", () => {
  const run = createHost({ directory: REPO, version: "2.4.1", pluginId: "colab", options: { access: "all" } })
  afterAll(async () => {
    const host = await run
    await host.close()
  })

  test("loads as colab, registers 24 tools, the pass-through rows and the one RPC id", async () => {
    const host = await run
    expect(host.refusal).toBeUndefined()
    expect(host.failure).toBeUndefined()
    expect(host.definition?.id).toBe("colab")
    expect(host.namespace?.name).toBe("colab")
    expect(host.namespace?.description).toBe(manifest.plugin.summary)
    expect(host.rpc?.id).toBe("colab")
    const registerMethods = Object.keys(manifest.methods).filter((method) => !method.startsWith("mcp:"))
    expect([...(host.rpc?.methods ?? [])].sort()).toEqual(registerMethods.sort())
    expect(host.tools.map((tool) => tool.permission).sort()).toEqual(registerMethods.map((method) => `colab.${method}`).sort())
    expect(host.rpc?.events).toEqual(["changed"])
  })

  test("answers the strict status over RPC", async () => {
    const host = await run
    const answer = await host.call("status", {})
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.output).toMatchObject({
      name: "colab",
      version: "0.0.0",
      host: { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] },
      state: "needs_sign_in",
      accounts: [{ alias: "default", state: "needs_sign_in" }],
      unguardedAgents: [],
      nextStep: "Sign in to the account that needs it, then read status again.",
    })
  })
})
