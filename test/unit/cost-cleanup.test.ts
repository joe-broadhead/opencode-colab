// `/colab-cleanup` (design §8.5, §16 F's checklist): at read-only it lists what costs money and takes no action,
// asserting nothing; at all it asserts the command's own action colab.cleanup once per runtime, without a source; at
// ask-changes it asserts the tool action colab.delete, so the person is never asked twice; a no ends that action and
// moves on. Every release goes through the one release function.
import { describe, expect, it } from "vitest"
import { cleanupActions, cleanupReport, runCleanup } from "../../src/cost/cleanup.js"
import { runtimeResource } from "../../src/domain/actions.js"
import { ColabError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import type { Release, RuntimeRecord } from "../../src/ports.js"
import { FakeClock, FakeRelease, MemoryLedger, T4 } from "../fakes/index.js"
import { RecordingAsserts, RecordingSynthetic } from "../fakes/cost-fakes.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const A = "oc-01jcostcleanupa00000000"
const B = "oc-01jcostcleanupb00000000"

const record = (id: string, overrides: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
  id,
  account: "default",
  backend: "colab",
  spec: T4,
  createdAt: "2026-11-17T10:00:00.000Z",
  nonce: "n1",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  ...overrides,
})

async function world(input: { access?: "all" | "ask-changes" | "read-only"; runtimes?: readonly RuntimeRecord[]; release?: Release; runs?: { runtime: string; state: "running" }[] } = {}) {
  const clock = new FakeClock(NOW)
  const ledger = new MemoryLedger(clock)
  for (const item of input.runtimes ?? [record(A), record(B)]) await ledger.putRuntime(item)
  for (const [index, run] of (input.runs ?? []).entries()) {
    await ledger.putRun({ runId: `run-${index}`, account: "default", backend: "colab", runtime: run.runtime, startedAt: NOW.toISOString(), state: run.state, cellIds: [], outputPaths: [] })
  }
  const options = await loadOptions({ access: input.access ?? "all" })
  const release = input.release ?? new FakeRelease()
  const asserts = new RecordingAsserts()
  const synthetic = new RecordingSynthetic()
  const deps = { options, ledger, release, clock }
  const run = () =>
    runCleanup({
      deps,
      sessionID: "ses_person",
      assert: asserts.assert,
      synthetic: (text, description) => synthetic.synthetic({ text, description }),
    })
  return { clock, ledger, options, release: release as FakeRelease, asserts, synthetic, deps, run }
}

describe("what the command lists", () => {
  it("lists live runtimes of ours with no run active, and skips a tainted one or one with a run in flight", async () => {
    const worldOf = await world({
      runtimes: [record(A), record(`${B}x`, { tainted: { code: "RUNTIME_SHARED", at: NOW.toISOString() } }), record(`${B}y`)],
      runs: [{ runtime: `${B}y`, state: "running" }],
    })
    const actions = await cleanupActions(worldOf.deps, NOW)
    expect(actions.map((action) => action.record.id)).toEqual([A])
  })

  it("says what a release loses, names the runtimes, and points Enterprise stops at their plan", async () => {
    const worldOf = await world()
    const report = cleanupReport(worldOf.deps, await cleanupActions(worldOf.deps, NOW), NOW)
    expect(report).toContain(A)
    expect(report).toContain(B)
    expect(report).toContain("Files outside keep and all variables in memory are lost at release")
    expect(report).toContain("runtime.stop plan")
    expect(report).toMatch(/asks you first/)
  })
})

describe("at read-only", () => {
  it("lists what costs money and takes no action, asserting nothing", async () => {
    const worldOf = await world({ access: "read-only" })
    const answer = await worldOf.run()
    expect(worldOf.asserts.requests).toEqual([])
    expect(worldOf.release.released).toEqual([])
    expect(answer.trace.released).toEqual([])
    expect(answer.outcome).toMatch(/Read only/)
    expect(answer.report).toMatch(/Read only: this is a report/)
    // The report is posted, and nothing else is: no outcome claim of a release.
    expect(worldOf.synthetic.posts).toHaveLength(1)
  })
})

describe("at all", () => {
  it("asks once per runtime with the command's own action and no source, then releases through the one release function", async () => {
    const worldOf = await world()
    const answer = await worldOf.run()

    expect(worldOf.asserts.requests).toEqual([
      expect.objectContaining({ sessionID: "ses_person", action: "colab.cleanup", resources: [runtimeResource("default", A)] }),
      expect.objectContaining({ sessionID: "ses_person", action: "colab.cleanup", resources: [runtimeResource("default", B)] }),
    ])
    // No `source`: a person-only prompt, never a tool call the model could replay.
    for (const request of worldOf.asserts.requests) expect(request).not.toHaveProperty("source")
    expect(worldOf.release.released.map((entry) => entry.id)).toEqual([A, B])
    expect(worldOf.release.released.every((entry) => entry.reason === "plan")).toBe(true)
    expect(answer.trace.released).toEqual([A, B])
    expect(worldOf.synthetic.posts).toHaveLength(2)
  })

  it("a no ends that one action, changes nothing, and moves on to the next", async () => {
    const worldOf = await world()
    worldOf.asserts.deny = (request) => request.resources?.some((resource) => resource.includes(A)) ?? false
    const answer = await worldOf.run()
    expect(worldOf.release.released.map((entry) => entry.id)).toEqual([B])
    expect(answer.trace.declined).toEqual([A])
    expect(answer.outcome).toBe("Colab cleanup: released 1, declined 1, failed 0.")
  })

  it("a resource that vanished between the plan and the release is reported, not hidden", async () => {
    const failing: Release = {
      release: async (runtime) => {
        if (runtime.id === A) throw new ColabError("RUNTIME_BUSY", "A run is active.")
        return { harvested: [], released: true, warnings: [] }
      },
    }
    const worldOf = await world({ release: failing })
    const answer = await worldOf.run()
    expect(answer.trace.failed).toEqual([{ runtime: A, code: "RUNTIME_BUSY" }])
    expect(answer.outcome).toBe("Colab cleanup: released 1, declined 0, failed 1.")
  })
})

describe("at ask-changes", () => {
  it("asserts the tool's own action colab.delete, which the default rules already ask", async () => {
    const worldOf = await world({ access: "ask-changes" })
    await worldOf.run()
    expect(worldOf.asserts.requests.map((request) => request.action)).toEqual(["colab.delete", "colab.delete"])
    expect(worldOf.asserts.requests[0]?.resources).toEqual([runtimeResource("default", A)])
    expect(worldOf.asserts.requests[0]?.metadata).toMatchObject({ account: "default", runtime: A, lost: expect.stringContaining("Files outside keep") })
  })
})

describe("nothing to do", () => {
  it("asks nothing and says so when no runtime of ours is live", async () => {
    const worldOf = await world({ runtimes: [] })
    const answer = await worldOf.run()
    expect(worldOf.asserts.requests).toEqual([])
    expect(worldOf.release.released).toEqual([])
    expect(answer.report).toContain("cost money now: 0")
    expect(answer.outcome).toBe("Colab cleanup: released 0, declined 0, failed 0.")
  })
})
