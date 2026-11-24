// The `colab.runtimes` snapshot (src/sources/runtimes.ts): one `output.list` per account, validated as a consumer
// validates it (source-contract's `acceptAnswer` against the latent descriptor fixture), with the one listing operation
// asserted as `colab.read`, TOO_LARGE past 50 items or a cut listing, and Google's refusals in the contract's codes.
import { acceptAnswer } from "@we-the-rebel-alliance/source-contract/read"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { EnterpriseRuntime, Listed } from "../../src/ports.js"
import { CPU, T4 } from "../fakes/index.js"
import { latentSources } from "../fakes/sources-descriptor.js"
import { HOME, LAB, ourRuntime, sourcesHarness } from "../fakes/sources-harness.js"

const checked = SOURCES_SCHEMA.check(latentSources())
if (!checked.ok) throw new Error(checked.problems.join("; "))
const declared = checked.value.items.find((item) => item.id === "colab.runtimes")!

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as Error).message
  }
  return "no refusal"
}

describe("colab.runtimes for a Colab account", () => {
  it("lists the plugin's own runtimes first, marks a tainted one, and one opened elsewhere", async () => {
    const h = sourcesHarness()
    h.fakes.clock.current = new Date("2026-11-17T10:00:00.000Z")
    await ourRuntime(h.ledger, "oc-01jownruntime00000000000000", HOME, "2026-11-17T08:00:00.000Z")
    await ourRuntime(h.ledger, "oc-01jtaintedruntime0000000000", HOME, "2026-11-17T09:30:00.000Z", "NONE")
    await h.ledger.taint("oc-01jtaintedruntime0000000000", { code: "RUNTIME_SHARED", at: "2026-11-17T09:40:00.000Z" })
    h.fakes.colab.runtimes.set("browser-runtime", { name: "runtimes/browser-runtime", spec: { ...T4, shape: "SHAPE_HIGHMEM" } })
    h.fakes.colab.runtimes.set("oc-01jownruntime00000000000000", { name: "runtimes/oc-01jownruntime00000000000000", spec: T4 })
    h.fakes.colab.runtimes.set("oc-01jtaintedruntime0000000000", { name: "runtimes/oc-01jtaintedruntime0000000000", spec: CPU })
    const answer = await h.tool("runtimes_read", { source: "runtimes", account: HOME })
    const accepted = acceptAnswer(declared, HOME, answer)
    expect(accepted.ok).toBe(true)
    expect((answer as { data: unknown }).data).toEqual({
      editable: false,
      items: [
        { id: "oc-01jownruntime00000000000000", text: "T4 GPU - the plugin's own", note: "Created 2 h ago; lease 20 min idle or 4 h, released then when the automation is on. Colab publishes no compute-unit rate." },
        {
          id: "oc-01jtaintedruntime0000000000",
          text: "CPU - the plugin's own, tainted (RUNTIME_SHARED): no more runs, released only by plan",
          note: "Created 30 min ago; not released automatically. Colab publishes no compute-unit rate.",
        },
        { id: "browser-runtime", text: "T4 GPU, high memory - not the plugin's own (opened elsewhere)", note: "The plugin never runs code on it, lists its files or releases it." },
      ],
    })
    expect(h.permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.runtimes_read", [HOME]],
      ["colab.read", [`${HOME}:colaboratory.runtimes.list`]],
    ])
  })

  it("calls Google only after colab.read is allowed", async () => {
    const h = sourcesHarness()
    h.permission.decide = (request) => {
      if (request.action === "colab.read") throw new Error("denied by the test's rules")
    }
    expect(await refusal(h.tool("runtimes_read", { account: HOME }))).toBe("denied by the test's rules")
    expect(h.fakes.colab.calls).toEqual([])
  })

  it("answers Google's refusals in the contract's codes", async () => {
    const h = sourcesHarness()
    const cases: [ColabError, RegExp][] = [
      [new ColabError("AUTH_REQUIRED"), /^NEEDS_SIGN_IN: /],
      [new ColabError("AUTH_SCOPE_MISSING"), /^SCOPE_MISSING: /],
      [new ColabError("RATE_LIMITED", "Google asked the plugin to slow down.", { retryAfterSec: 30 }), /^RATE_LIMITED: /],
      [new ColabError("PERMISSION_DENIED"), /^PERMISSION_DENIED: /],
      [new ColabError("COLAB_API_UNAVAILABLE"), /^UNAVAILABLE: COLAB_API_UNAVAILABLE: /],
    ]
    for (const [error, code] of cases) {
      h.fakes.colab.listRuntimes = async () => {
        throw error
      }
      expect(await refusal(h.tool("runtimes_read", { account: HOME }))).toMatch(code)
    }
  })

  it("is TOO_LARGE past the list's 50 items", async () => {
    const h = sourcesHarness()
    for (let index = 0; index < 51; index++) h.fakes.colab.runtimes.set(`r-${index}`, { name: `runtimes/r-${index}`, spec: CPU })
    expect(await refusal(h.tool("runtimes_read", { account: HOME }))).toMatch(/^TOO_LARGE: /)
  })

  it("keeps 50 of the longest items inside the descriptor's maxBytes", async () => {
    const h = sourcesHarness()
    for (let index = 0; index < 50; index++) {
      const id = `oc-${String(index).padStart(2, "0")}${"x".repeat(60)}`
      h.fakes.colab.runtimes.set(id, { name: `runtimes/${id}`, spec: { ...T4, shape: "SHAPE_HIGHMEM", accelerator: "A".repeat(40) } })
      await ourRuntime(h.ledger, id)
      await h.ledger.taint(id, { code: "RUNTIME_HAS_CREDENTIALS", at: "2026-11-17T09:00:00.000Z" })
    }
    const answer = await h.tool("runtimes_read", { account: HOME })
    expect(acceptAnswer(declared, HOME, answer).ok).toBe(true)
  })

  it("refuses another source's name", async () => {
    const h = sourcesHarness()
    expect(await refusal(h.tool("runtimes_read", { source: "runs", account: HOME }))).toMatch(/^SOURCE_UNKNOWN: /)
  })
})

describe("colab.runtimes for a Colab Enterprise account", () => {
  it("names machine, accelerator, state, the price table's USD/h and the flags, and asserts the Vertex listing", async () => {
    const h = sourcesHarness()
    h.fakes.vertex.runtimes.set("a", { name: "projects/invented-project/locations/us-central1/notebookRuntimes/rt-a", state: "RUNNING", machineType: "e2-standard-4", idleShutdownMinutes: 180, euc: true })
    h.fakes.vertex.runtimes.set("b", { name: "projects/invented-project/locations/us-central1/notebookRuntimes/rt-b", state: "STOPPED", machineType: "n1-standard-4", accelerator: "T4", idleShutdownMinutes: null, template: "projects/p/locations/l/notebookRuntimeTemplates/tpl-1" })
    const answer = await h.tool("runtimes_read", { account: LAB })
    expect(acceptAnswer(declared, LAB, answer).ok).toBe(true)
    expect((answer as { data: { items: unknown[] } }).data.items).toEqual([
      { id: "rt-a", text: "Colab Enterprise runtime, e2-standard-4, RUNNING, about $0.19/h", note: "idle shutdown after 180 min; end-user credentials on." },
      { id: "rt-b", text: "Colab Enterprise runtime, n1-standard-4 + T4, STOPPED", note: "idle shutdown off; stopped: its disk still bills; template tpl-1." },
    ])
    expect(h.permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.runtimes_read", [LAB]],
      ["colab.read", [`${LAB}:aiplatform.projects.locations.notebookRuntimes.list`]],
    ])
  })

  it("is TOO_LARGE when the listing was cut at its page bound", async () => {
    const h = sourcesHarness()
    const cut: Listed<EnterpriseRuntime> = Object.assign([] as EnterpriseRuntime[], { truncated: true })
    ;(h.fakes.vertex as unknown as { listRuntimes: () => Promise<Listed<EnterpriseRuntime>> }).listRuntimes = async () => cut
    expect(await refusal(h.tool("runtimes_read", { account: LAB }))).toMatch(/^TOO_LARGE: /)
  })
})
