// package.json's `sources` against source-contract v0.2.0: `assertDeclaration` with the tools RPC's methods as the
// declared tools, the descriptor as a consumer reads it from the install, and the RPC id the plugin registers. Package
// G adds the conformance kit's run over `events_list`, `runtimes_read` and `probe` (test/conformance/sources.test.ts).
import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { assertDeclaration, declarationProblems } from "@we-the-rebel-alliance/source-contract/conformance"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { TOOLS } from "../../src/domain/actions.js"
import { METHOD_NAMES, TOOLS_RPC_ID } from "../../src/tools-rpc.js"

const ROOT = join(import.meta.dir, "..", "..")
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { sources: { rpc: string; probe: { action: string }; items: { id: string; tool: string }[] } }

/** The tools RPC's methods, as describe lists them: the twelve read tools and the probe, all read-only. */
const tools = METHOD_NAMES.map((id) => ({ id, readOnly: id === "probe" || TOOLS.find((tool) => tool.name === id)?.class === "read" }))

test("the sources block passes assertDeclaration with the plugin's methods", () => {
  expect(declarationProblems(pkg.sources, { tools })).toEqual([])
  expect(() => assertDeclaration(pkg.sources, { tools })).not.toThrow()
})

test("a consumer reads the descriptor from the install", () => {
  const installed = readInstalledDescriptor(ROOT)
  if (!installed.ok) throw new Error(installed.problems.join("; "))
  expect(installed.ok).toBe(true)
})

test("names the RPC the plugin registers, its probe action, and the two v0.1.0 sources", () => {
  expect(pkg.sources.rpc).toBe(TOOLS_RPC_ID)
  expect(pkg.sources.probe.action).toBe("colab.probe")
  expect(pkg.sources.items.map((item) => [item.id, item.tool])).toEqual([["colab.runs", "events_list"], ["colab.runtimes", "runtimes_read"]])
})
