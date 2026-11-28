// The record for colab-plugin#29: Google's Colab MCP server is a browser bridge with no API tools, and Google Cloud's
// Agent Platform notebook toolset covers only the Enterprise half of the job, so the plugin keeps its own provider and
// sign-in. The README carries both links and the date checked.
import { readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { manifest } from "../../src/manifest.js"

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8")
const prose = README.replace(/\s+/g, " ")

describe("Google's MCP servers for Colab", () => {
  test("the README records why there is no server to build on, with its links and the date checked", () => {
    expect(prose).toContain("https://github.com/googlecolab/colab-mcp")
    expect(prose).toContain("https://docs.cloud.google.com/gemini-enterprise-agent-platform/reference/mcp")
    expect(prose).toContain("checked 28 November 2026")
    expect(prose).toContain("open_colab_browser_connection")
    expect(prose).toContain("/mcp/notebook")
    expect(prose).toContain("24 Colab Enterprise tools")
    expect(prose).toContain("no server to build on for this plugin's job")
  })

  test("the README names the two gaps that keep the plugin on its own provider", () => {
    expect(prose).toContain("plans those Enterprise changes and previews them before they commit")
    expect(prose).toContain("headless `adc` and `token` accounts do not have")
  })

  test("the manifest builds on none of its tools", () => {
    expect(manifest.accounts?.via).toBe("integration")
    expect(Object.keys(manifest.methods).filter((method) => method === "mcp:*" || method.startsWith("mcp:"))).toEqual([])
  })
})
