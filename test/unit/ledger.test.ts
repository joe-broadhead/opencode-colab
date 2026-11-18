// The file ledger and the in-memory one (test/fakes) against the same contract: records, taint once, events with a
// monotonic seq and an expired cursor, pruning, copy-on-write files with private modes, and the cross-process lock.
import { mkdtempSync, readdirSync, rmSync, statSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileLedger, ledgerDir } from "../../src/ledger/store.js"
import type { Ledger, RunRecord, RuntimeRecord } from "../../src/ports.js"
import { CPU, FakeClock, MemoryLedger } from "../fakes/index.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "colab-ledger-"))
  dirs.push(dir)
  return join(dir, "ledger")
}

const runtime = (id: string, extra: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
  id,
  account: "default",
  backend: "colab",
  spec: CPU,
  createdAt: "2026-11-17T09:00:00.000Z",
  nonce: "n0nce",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  ...extra,
})
const run = (runId: string, extra: Partial<RunRecord> = {}): RunRecord => ({ runId, account: "default", backend: "colab", runtime: "oc-01", cellIds: ["c1"], startedAt: "2026-11-17T09:01:00.000Z", state: "ok", outputPaths: [], ...extra })

const kinds: [string, (clock: FakeClock) => Ledger][] = [
  ["file", (clock) => new FileLedger(temp(), { ledgerDays: 90, clock })],
  ["memory", (clock) => new MemoryLedger(clock)],
]

for (const [kind, make] of kinds) {
  describe(`the ${kind} ledger`, () => {
    it("keeps runtimes and runs, and filters them", async () => {
      const ledger = make(new FakeClock())
      await ledger.putRuntime(runtime("oc-01"))
      await ledger.putRuntime(runtime("oc-02", { state: "released", releasedAt: "2026-11-17T10:00:00.000Z" }))
      await ledger.putRun(run("run-1"))
      await ledger.putRun(run("run-2", { account: "work" }))
      expect((await ledger.getRuntime("oc-01"))?.nonce).toBe("n0nce")
      expect((await ledger.listRuntimes({ live: true })).map((record) => record.id)).toEqual(["oc-01"])
      expect((await ledger.listRuns({ account: "work" })).map((record) => record.runId)).toEqual(["run-2"])
      expect(await ledger.getRun("missing")).toBeUndefined()
    })

    it("keeps an Enterprise job's USD estimate, so the daily budget can price the day", async () => {
      const ledger = make(new FakeClock())
      await ledger.putRun(run("job-1", { backend: "enterprise", job: "jobs/oc-job-1", estimatedUsd: 4.9 }))
      expect((await ledger.getRun("job-1"))?.estimatedUsd).toBe(4.9)
      expect((await ledger.listRuns({ account: "default" })).find((record) => record.runId === "job-1")?.estimatedUsd).toBe(4.9)
    })

    it("keeps a run's kernel session name, so a detached run can be cancelled", async () => {
      const ledger = make(new FakeClock())
      await ledger.putRun(run("run-s", { state: "detached", session: "oc-n0nce-scratch" }))
      expect((await ledger.getRun("run-s"))?.session).toBe("oc-n0nce-scratch")
      expect((await ledger.listRuns({ state: "detached" })).map((record) => record.session)).toEqual(["oc-n0nce-scratch"])
    })

    it("taints a runtime once, for good, with one event", async () => {
      const ledger = make(new FakeClock())
      await ledger.putRuntime(runtime("oc-01"))
      const first = await ledger.taint("oc-01", { code: "RUNTIME_SHARED", at: "2026-11-17T09:05:00.000Z" })
      const second = await ledger.taint("oc-01", { code: "RUNTIME_HAS_CREDENTIALS", at: "2026-11-17T09:06:00.000Z" })
      expect(first?.tainted?.code).toBe("RUNTIME_SHARED")
      expect(second?.tainted?.code).toBe("RUNTIME_SHARED")
      expect((await ledger.eventsSince(0, 10)).events.map((event) => event.type)).toEqual(["runtime.tainted"])
    })

    it("numbers events from 1, pages after a cursor, and says when a cursor is older than what is kept", async () => {
      const clock = new FakeClock()
      const ledger = make(clock)
      for (const id of ["a", "b", "c"]) await ledger.append({ type: "run.finished", id, account: "default" })
      expect((await ledger.eventsSince(0, 2)).events.map((event) => [event.seq, event.id])).toEqual([[1, "a"], [2, "b"]])
      expect((await ledger.eventsSince(2, 10)).events.map((event) => event.id)).toEqual(["c"])
      clock.advance(100 * 86_400_000)
      await ledger.append({ type: "run.finished", id: "d", account: "default" })
      await ledger.prune(clock.now())
      const page = await ledger.eventsSince(1, 10)
      expect(page.events.map((event) => event.id)).toEqual(["d"])
      expect(page.expired).toBe(true)
      expect((await ledger.eventsSince(3, 10)).expired).toBe(false)
    })
  })
}

describe("the file ledger on disk", () => {
  it("lives under $XDG_STATE_HOME/opencode-colab/ledger", () => {
    expect(ledgerDir({ XDG_STATE_HOME: "/state" })).toBe("/state/opencode-colab/ledger")
  })

  it("writes private files with no temp file left, and prunes finished records past ledgerDays", async () => {
    const clock = new FakeClock()
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90, clock })
    await ledger.putRuntime(runtime("oc-01", { state: "released", releasedAt: "2026-01-01T00:00:00.000Z" }))
    await ledger.putRuntime(runtime("oc-02"))
    await ledger.putRun(run("run-1", { endedAt: "2026-01-01T00:00:00.000Z" }))
    await ledger.putRun(run("run-2", { state: "running" }))
    expect(statSync(join(dir, "runtimes", "oc-01.json")).mode & 0o777).toBe(0o600)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(readdirSync(join(dir, "runtimes")).filter((name) => name.includes(".tmp-"))).toEqual([])
    expect(await ledger.prune(clock.now())).toBe(2)
    expect((await ledger.listRuntimes()).map((record) => record.id)).toEqual(["oc-02"])
    expect((await ledger.listRuns()).map((record) => record.runId)).toEqual(["run-2"])
  })

  it("refuses an id that cannot be a file name", async () => {
    const ledger = new FileLedger(temp(), { ledgerDays: 90 })
    await expect(ledger.getRuntime("../escape")).rejects.toThrow(/^NOT_FOUND: /)
  })

  it("waits for another holder's lock, breaks a stale one, and gives up with LEDGER_UNAVAILABLE", async () => {
    const dir = temp()
    mkdirSync(join(dir, "lock"), { recursive: true })
    writeFileSync(join(dir, "lock", "owner"), String(process.pid))
    const held = new FileLedger(dir, { ledgerDays: 90, lockTimeoutMs: 50 })
    await expect(held.putRuntime(runtime("oc-01"))).rejects.toThrow(/^LEDGER_UNAVAILABLE: /)
    // An old lock whose owner is gone is broken.
    writeFileSync(join(dir, "lock", "owner"), "999999999")
    const old = new Date(Date.now() - 60_000)
    utimesSync(join(dir, "lock"), old, old)
    await new FileLedger(dir, { ledgerDays: 90, lockTimeoutMs: 50 }).putRuntime(runtime("oc-01"))
    expect((await held.getRuntime("oc-01"))?.id).toBe("oc-01")
  })
})
