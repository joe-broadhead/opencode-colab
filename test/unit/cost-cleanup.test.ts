// `/colab-cleanup` (design §8.5, §16 F's checklist): at read-only it lists what costs money and takes no action,
// asserting nothing; at all it asserts the command's own action colab.cleanup once per runtime, without a source; at
// ask-changes it asserts the tool action colab.delete, so the person is never asked twice; a no ends that action and
// moves on. Every release goes through the one release function.
import { describe, expect, it } from "vitest"
import { cleanupActions, cleanupReport } from "../../src/provider/cost/cleanup.js"
import { runtimeResource } from "../../src/domain/actions.js"
import { ColabError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import type { Release, RuntimeRecord } from "../../src/provider/ports.js"
import { FakeClock, FakeRelease, MemoryLedger, T4 } from "../fakes/index.js"

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
  const deps = { options, ledger, release, clock }
  return { clock, ledger, options, release: release as FakeRelease, deps }
}

describe("what the command lists", () => {
  it("lists every live runtime of ours, whatever it has run: tainted ones and ones with a run recorded running", async () => {
    const worldOf = await world({
      runtimes: [record(A), record(`${B}x`, { tainted: { code: "RUNTIME_SHARED", at: NOW.toISOString() } }), record(`${B}y`)],
      runs: [{ runtime: `${B}y`, state: "running" }],
    })
    const actions = await cleanupActions(worldOf.deps, NOW)
    expect(actions.map((action) => action.record.id)).toEqual([A, `${B}x`, `${B}y`])
    expect(actions.map((action) => action.blocked)).toEqual([false, false, true])
  })

  it("says what a release loses, names the runtimes, and points Enterprise stops at their plan", async () => {
    const worldOf = await world()
    const report = cleanupReport(worldOf.deps, await cleanupActions(worldOf.deps, NOW), NOW)
    expect(report).toContain(A)
    expect(report).toContain(B)
    expect(report).toContain("Files outside keep and memory are lost at release")
    expect(report).toContain("runtime.stop plan")
    expect(report).toContain("Each release is a change")
  })
})
