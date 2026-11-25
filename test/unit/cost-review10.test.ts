// Review colab #10 (399622ca), R1–R5, with the fixed expectations. R1, R2 and R5 run through package B's real
// transport and Colab client, so the fence that hid M1 and M2 is the real one (review LOW 6). R4 uses the run shape the
// accepted contract request 1 gives E: `estimatedUsd` at the job's commit.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { runAutomationOnce } from "../../src/provider/cost/automation.js"
import { createBudget } from "../../src/provider/cost/index.js"
import { cleanupActions } from "../../src/provider/cost/cleanup.js"
import { createRelease } from "../../src/provider/cost/release.js"
import { confirmJobCreate, openJobCreate } from "../../src/provider/enterprise/runs.js"
import type { PortEnv } from "../../src/provider/index.js"
import { loadOptions } from "../../src/options.js"
import type { RunRecord, RuntimeRecord } from "../../src/provider/ports.js"
import { CLEAN_CALIBRATION, FakeClock, FakePrices, MemoryLedger, T4 } from "../fakes/index.js"
import { createRuntimeFixture } from "../fakes/runtime-env.js"

const temporary: string[] = []
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "colab10-"))
  temporary.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const NOW = new Date("2026-11-17T12:00:00.000Z")

const sweep = async (fixture: Awaited<ReturnType<typeof createRuntimeFixture>>, now = NOW) =>
  runAutomationOnce({
    options: fixture.options,
    ledger: fixture.ledger,
    runtime: fixture.ports.runtime,
    colab: fixture.ports.colab,
    release: createRelease({ ...fixture.env, directory: tempDir() }, fixture.ports),
    now,
    signal: fixture.signal(),
  })

describe("reviewer repro, colab #10", () => {
  it("R1: one sweep through B's real transport does not close a still-`creating` runtime as gone", async () => {
    const fixture = await createRuntimeFixture()
    try {
      // A create whose LRO outlived the wait: the ledger holds `creating`, Colab holds (and bills) the runtime.
      const record = await fixture.own(undefined, { state: "creating" })
      const outcome = await sweep(fixture)
      const after = await fixture.ledger.getRuntime(record.id)
      expect(fixture.api.runtimes.has(record.id)).toBe(true)
      expect(after?.state).toBe("creating")
      // Three hours old: the report names it rather than acting.
      expect(outcome.attention.join(" ")).toContain("its create never finished")
    } finally {
      await fixture.close()
    }
  })

  it("R2: a person's plan can release a still-`creating` runtime of ours, through the one function and B's real fence", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const record = await fixture.own(undefined, { state: "creating" })
      const release = createRelease({ ...fixture.env, directory: tempDir() }, fixture.ports)
      const answer = await release.release(record, { reason: "plan", force: false }, fixture.signal())
      expect(answer.released).toBe(true)
      expect(answer.warnings).toEqual(["UNHARVESTED"])
      expect(fixture.api.runtimes.has(record.id)).toBe(false)
      expect((await fixture.ledger.getRuntime(record.id))?.state).toBe("released")
    } finally {
      await fixture.close()
    }
  })

  it("R2b: a create that never landed (404) closes as gone with nothing lost", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const record = await fixture.own(undefined, { state: "creating" })
      fixture.api.runtimes.delete(record.id)
      const release = createRelease({ ...fixture.env, directory: tempDir() }, fixture.ports)
      const answer = await release.release(record, { reason: "plan", force: false }, fixture.signal())
      expect(answer).toMatchObject({ released: true, warnings: [] })
      expect((await fixture.ledger.getRuntime(record.id))?.state).toBe("gone")
    } finally {
      await fixture.close()
    }
  })

  it("R3: /colab-cleanup offers a ready runtime whose last run finished an hour ago", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    const runtime: RuntimeRecord = {
      id: "oc-01jreview10cleanup000000",
      account: "default",
      backend: "colab",
      spec: T4,
      createdAt: "2026-11-17T08:00:00.000Z",
      nonce: "n1",
      keep: ["/content/outputs/**"],
      lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
      state: "ready",
    }
    await ledger.putRuntime(runtime)
    const done: RunRecord = { runId: "r1", account: "default", backend: "colab", runtime: runtime.id, cellIds: [], startedAt: "2026-11-17T10:30:00.000Z", endedAt: "2026-11-17T11:00:00.000Z", state: "ok", outputPaths: [] }
    await ledger.putRun(done)
    const options = loadOptions({})
    const actions = await cleanupActions({ options, ledger, release: { release: async () => ({ harvested: [], released: true, warnings: [] }) }, clock }, NOW)
    expect(actions.map((action) => action.record.id)).toEqual([runtime.id])
    expect(actions[0]).toMatchObject({ blocked: false, quietMinutes: 60 })
  })

  it("R4: a refuse budget of $10 a day refuses the third $5 job, created through package E's writers", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    // Two jobs E created: `openJobCreate` stores the preview's estimate, `confirmJobCreate` keeps it.
    for (const id of ["oc-job-a", "oc-job-b"]) {
      await openJobCreate({ ledger, clock }, "default", id, { summary: `Colab Enterprise job ${id}`, estimatedUsd: 5 })
      await confirmJobCreate({ ledger, clock }, "default", { name: `projects/p/locations/us-central1/notebookExecutionJobs/${id}`, displayName: id, state: "JOB_STATE_SUCCEEDED", endTime: "2026-11-17T10:00:00.000Z" })
    }
    expect((await ledger.getRun("oc-job-a"))?.estimatedUsd).toBe(5)
    const options = loadOptions({ accounts: { default: { budget: { enterpriseUsdDaily: 10, action: "refuse" } } } })
    const budget = createBudget({ options, ledger, clock, auth: { token: async () => "t", identity: async () => undefined, scopes: async () => [] }, directory: tempDir(), fetch: globalThis.fetch } as PortEnv, new FakePrices())
    expect(await budget.check("default", { action: "job.create", usd: 5 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 10, limit: 10, unit: "usd" })
  })

  it("R4b: a legacy run without an estimate is uncounted, so a call within the rest of the limit answers ok", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    await ledger.putRun({ runId: "job-a", account: "default", backend: "enterprise", job: "projects/p/locations/us-central1/notebookExecutionJobs/job-a", startedAt: "2026-11-17T09:00:00.000Z", endedAt: "2026-11-17T10:00:00.000Z", state: "ok", cellIds: [], outputPaths: [], summary: "Colab Enterprise job" })
    const options = loadOptions({ accounts: { default: { budget: { enterpriseUsdDaily: 10, action: "refuse" } } } })
    const budget = createBudget({ options, ledger, clock, auth: { token: async () => "t", identity: async () => undefined, scopes: async () => [] }, directory: tempDir(), fetch: globalThis.fetch } as PortEnv, new FakePrices())
    expect(await budget.check("default", { action: "job.create", usd: 5 }, new AbortController().signal)).toEqual({ verdict: "ok" })
    // The same call counted against the limit alone still refuses when its own estimate is over it.
    expect(await budget.check("default", { action: "job.create", usd: 11 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 0, limit: 10, unit: "usd" })
  })

  it("R5 (LOW 1): a `running` run left by a process that died is named, not silently blocking", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const record = await fixture.own()
      await fixture.ledger.putRun({ runId: "orphan", account: "default", backend: "colab", runtime: record.id, cellIds: [], startedAt: "2026-11-17T09:01:00.000Z", state: "running", outputPaths: [] })
      const outcome = await sweep(fixture, new Date("2026-11-18T09:00:00.000Z"))
      expect(outcome.released).toEqual([])
      expect(outcome.attention.join(" ")).toContain("a run has been running since 2026-11-17T09:01:00.000Z")
    } finally {
      await fixture.close()
    }
  })
})

describe("M1's ledger-state matrix, through B's real transport", () => {
  it("leaves a `creating` runtime creating, a ready one idle, a tainted one closed to automation, and never reopens a released one", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const creating = await fixture.own("oc-01jmatrixcreating000000", { state: "creating" })
      const ready = await fixture.own("oc-01jmatrixready0000000000", { calibration: CLEAN_CALIBRATION })
      const tainted = await fixture.own("oc-01jmatrixtainted0000000", { tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: NOW.toISOString() } })
      const released = await fixture.own("oc-01jmatrixreleased000000", { state: "released", releasedAt: NOW.toISOString() })
      const outcome = await sweep(fixture, new Date("2026-11-17T13:00:00.000Z"))

      // `creating` is tracked and named, not forgotten; `ready` is idle and released; the tainted one is left alone.
      expect((await fixture.ledger.getRuntime(creating.id))?.state).toBe("creating")
      expect(outcome.released.map((entry) => entry.id)).toEqual([ready.id])
      expect((await fixture.ledger.getRuntime(tainted.id))?.tainted?.code).toBe("RUNTIME_HAS_CREDENTIALS")
      expect((await fixture.ledger.getRuntime(released.id))?.state).toBe("released")
      expect(outcome.attention.join(" ")).toContain("tainted")
    } finally {
      await fixture.close()
    }
  })

  it("never releases a runtime whose account is read, and says why (ruling 6, LOW 3)", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    const runtime = { id: "oc-01jreadaccount000000000", account: "default", backend: "colab" as const, spec: T4, createdAt: "2026-11-17T09:00:00.000Z", nonce: "n1", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready" as const }
    await ledger.putRuntime(runtime)
    const release = { calls: 0, release: async () => ((release.calls += 1), { harvested: [], released: true, warnings: [] }) }
    const outcome = await runAutomationOnce({
      options: await loadOptions({ accounts: { default: { access: "read" } } }),
      ledger,
      runtime: { kernels: async () => [], sessions: async () => [] } as never,
      colab: { getRuntime: async () => ({}) } as never,
      release,
      now: NOW,
      signal: new AbortController().signal,
    })
    expect(release.calls).toBe(0)
    expect(outcome.attention.join(" ")).toContain("its account is read")
  })
})
