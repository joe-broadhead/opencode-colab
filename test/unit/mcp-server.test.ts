// The record for colab-plugin#29: Google's Colab MCP server is a browser bridge and covers none of this plugin's job;
// Google Cloud's Agent Platform notebook toolset carries the Colab Enterprise reads, so the plugin builds on it and
// passes those reads through as mcp: tools. The README carries both links and the date checked.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import { MCP_READS, refuseMcpRead } from "../../src/domain/mcp.js"
import { manifest } from "../../src/manifest.js"
import { loadOptions } from "../../src/options.js"
import { runTool } from "../support/methods.js"
import { fakeDeps } from "../fakes/index.js"

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
const prose = README.replace(/\s+/g, " ")

const account = (profile: Record<string, unknown>) => loadOptions({ accounts: { work: profile } }).accounts[0]!

describe("Google's MCP servers for Colab", () => {
  test("the README records which server serves the job, with its links and the date checked", () => {
    expect(prose).toContain("https://github.com/googlecolab/colab-mcp")
    expect(prose).toContain("https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/mcp")
    expect(prose).toContain("checked 28 November 2026")
    expect(prose).toContain("open_colab_browser_connection")
    expect(prose).toContain("/mcp/notebook")
    expect(prose).toContain("builds on it")
    expect(prose).toContain("headless `adc` or `token` account")
  })

  test("the manifest declares the server mechanism and the Enterprise reads as pass-through tools", () => {
    expect(manifest.accounts?.via).toBe("mcp")
    const rows = Object.keys(manifest.methods).filter((method) => method.startsWith("mcp:"))
    expect(rows).toHaveLength(8)
    for (const tool of Object.values(MCP_READS)) expect(rows).toContain(tool)
    for (const row of rows) expect(manifest.methods[row]?.class).toBe("read")
  })

  test("an interactive Enterprise account's own read refuses and names the tool", () => {
    const work = account({ backend: "enterprise", project: "p", region: "us-central1" })
    expect(() => refuseMcpRead("jobs", {}, work)).toThrow(ColabError)
    try {
      refuseMcpRead("jobs", {}, work)
    } catch (error) {
      expect(error).toBeInstanceOf(ColabError)
      if (error instanceof ColabError) {
        expect(error.code).toBe("MCP_HANDOFF")
        expect(error.next).toContain("mcp:notebook_execution_list_jobs")
      }
    }
  })

  test("a headless Enterprise account and a consumer account keep the plugin's own read", () => {
    expect(() => refuseMcpRead("jobs", {}, account({ backend: "enterprise", mode: "adc", project: "p", region: "us-central1" }))).not.toThrow()
    expect(() => refuseMcpRead("jobs", {}, account({ mode: "token", tokenEnv: "COLAB_TOKEN" }))).not.toThrow()
    expect(() => refuseMcpRead("specs", {}, account({}))).not.toThrow()
  })

  test("the shipped handler answers an interactive Enterprise read with the tool, before the provider is called", async () => {
    const { deps } = fakeDeps({ options: { accounts: { work: { backend: "enterprise", project: "p", region: "us-central1" } } } })
    const call = { sessionID: "ses_mcp", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal }
    const answer = (await runTool("jobs", { account: "work" }, call, { deps })) as { state: string; error?: string; next?: string }
    expect(answer.state).toBe("failed")
    expect(answer.error).toBe("UNAVAILABLE")
    expect(answer.next).toContain("mcp:notebook_execution_list_jobs")
  })
})
