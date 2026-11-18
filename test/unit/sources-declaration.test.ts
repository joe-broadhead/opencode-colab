// The `sources` declaration against what a consumer of today accepts. Jelly and Memory vendor source-contract v0.1.x
// until they re-vendor v0.2.0, and v0.1.x refuses keys v0.2.0 added: a declaration or an answer carrying one makes the
// whole plugin unreadable as a source. This fails when one appears in package.json `sources`, in a page, or in a probe
// answer. It also pins contract request 1 (test/fakes/sources-descriptor.ts): the one refused key Day 0's block still
// holds, and the `input` it lacks, so the exception goes as soon as the request lands.
import { describe, expect, it } from "vitest"
import { declarationProblems } from "@we-the-rebel-alliance/source-contract/conformance"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { RUNS_MAX_BYTES } from "../../src/sources/runs.js"
import { RUNTIMES_MAX_BYTES } from "../../src/sources/runtimes.js"
import { METHOD_NAMES } from "../../src/tools-rpc.js"
import { TOOLS } from "../../src/domain/actions.js"
import { PACKAGE } from "../../src/sources/index.js"
import { consumerRun, drain, HOME, LAB, sourcesHarness } from "../fakes/sources-harness.js"
import { PACKAGE_NAME, requestedSources, shippedSources, v01RefusedKeys } from "../fakes/sources-descriptor.js"

const tools = METHOD_NAMES.map((id) => ({ id, readOnly: id === "probe" || TOOLS.find((tool) => tool.name === id)?.class === "read" }))

describe("keys a v0.1.x consumer refuses", () => {
  it("finds each refused key wherever it sits", () => {
    const planted = {
      items: [
        {
          accounts: { named: true, server: "x-{account}" },
          permission: { identity: [], identityRules: [], readsIdentity: true },
          cost: { class: "billed", units: [{ per: "call", usd: 1, min: 1, conditions: "x" }] },
          example: { owner: { verified: false }, removals: [] },
        },
      ],
    }
    expect(v01RefusedKeys(planted)).toEqual([
      "sources.items[0].accounts.server",
      "sources.items[0].permission.identity (empty)",
      "sources.items[0].permission.identityRules",
      "sources.items[0].permission.readsIdentity",
      "sources.items[0].cost.units[0].min",
      "sources.items[0].cost.units[0].conditions",
      "sources.items[0].example.owner.verified",
      "sources.items[0].example.removals",
    ])
    expect(v01RefusedKeys({ items: [{ permission: { identity: ["x.users.get"] } }] })).toEqual([])
  })

  it("package.json holds none but the empty identity contract request 1 removes", () => {
    expect(v01RefusedKeys(shippedSources())).toEqual(["sources.items[0].permission.identity (empty)", "sources.items[1].permission.identity (empty)"])
  })

  it("with contract request 1 applied it holds none, and the request changes nothing else", () => {
    const requested = requestedSources()
    expect(v01RefusedKeys(requested)).toEqual([])
    expect(declarationProblems(requested, { tools })).toEqual([])
    expect(SOURCES_SCHEMA.check(requested).ok).toBe(true)
    const strip = (block: ReturnType<typeof shippedSources>) =>
      JSON.stringify(block, (key, value) => (key === "input" || (key === "identity" && Array.isArray(value) && value.length === 0) ? undefined : value))
    expect(strip(requested)).toBe(strip(shippedSources()))
    expect(JSON.stringify(requested)).not.toBe(JSON.stringify(shippedSources()))
  })

  it("no page and no probe answer carries a refused key", async () => {
    const h = sourcesHarness()
    await consumerRun(h.ledger, { runId: "r1", start: Date.parse("2026-11-17T08:00:00.000Z"), end: Date.parse("2026-11-17T08:30:00.000Z") })
    const read = await drain(h.tool, { account: HOME })
    const answers = [
      await h.tool("events_list", { source: "runs", account: HOME, cursor: read.cursor }),
      await h.tool("runtimes_read", { source: "runtimes", account: HOME }),
      await h.tool("runtimes_read", { source: "runtimes", account: LAB }),
      await h.probe({ source: "runs", account: HOME }),
    ]
    for (const answer of answers) expect(v01RefusedKeys(answer as never, "answer")).toEqual([])
    expect(read.events).toHaveLength(1)
  })
})

describe("the declaration and the code agree", () => {
  it("names the package, and each source's maxBytes as the code caps it", () => {
    expect(PACKAGE).toBe(PACKAGE_NAME)
    const items = shippedSources()["items"] as { id: string; maxBytes: number }[]
    expect(items.map((item) => [item.id, item.maxBytes])).toEqual([
      ["colab.runs", RUNS_MAX_BYTES],
      ["colab.runtimes", RUNTIMES_MAX_BYTES],
    ])
  })
})
