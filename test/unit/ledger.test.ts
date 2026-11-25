// The file ledger and the in-memory one (test/fakes) against the same contract: records, taint once, events with a
// monotonic seq and an expired cursor, pruning, copy-on-write files with private modes, and the cross-process lock.
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, mkdirSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

/** Bytes read through node:fs while `counting` is on: a whole-log read on append shows up here. */
const reads = { counting: false, bytes: 0 }
vi.mock("node:fs", async (original) => {
  const fs = (await original()) as typeof import("node:fs")
  return {
    ...fs,
    readFileSync: ((...args: Parameters<typeof fs.readFileSync>) => {
      const out = fs.readFileSync(...args)
      if (reads.counting) reads.bytes += out.length
      return out
    }) as typeof fs.readFileSync,
    readSync: ((...args: Parameters<typeof fs.readSync>) => {
      const read = fs.readSync(...args)
      if (reads.counting) reads.bytes += read
      return read
    }) as typeof fs.readSync,
  }
})
import { FileLedger, ledgerDir } from "../../src/provider/ledger/store.js"
import type { Ledger, RunRecord, RuntimeRecord } from "../../src/provider/ports.js"
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

    it("appends run.finished once per transition to final: none for a rewrite of a final record, one again after a reopen", async () => {
      const ledger = make(new FakeClock())
      const finished = async () => (await ledger.eventsSince(0, 100)).events.filter((event) => event.type === "run.finished" && event.id === "run-f").length
      await ledger.putRun(run("run-f", { state: "running" }))
      expect(await finished()).toBe(0)
      await ledger.putRun(run("run-f", { state: "detached" }))
      expect(await finished()).toBe(0)
      await ledger.putRun(run("run-f", { state: "ok", endedAt: "2026-11-17T09:05:00.000Z" }))
      expect(await finished()).toBe(1)
      await ledger.putRun(run("run-f", { state: "ok", endedAt: "2026-11-17T09:05:00.000Z", outputPaths: ["x"] }))
      expect(await finished()).toBe(1)
      await ledger.putRun(run("run-f", { state: "running" }))
      await ledger.putRun(run("run-f", { state: "error", endedAt: "2026-11-17T09:09:00.000Z" }))
      expect(await finished()).toBe(2)
      // A final state with no end time is not final yet.
      await ledger.putRun(run("run-g", { state: "ok" }))
      expect((await ledger.eventsSince(0, 100)).events.some((event) => event.id === "run-g")).toBe(false)
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
  it("lives under $XDG_STATE_HOME/colab/ledger", () => {
    expect(ledgerDir({ XDG_STATE_HOME: "/state" })).toBe("/state/colab/ledger")
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

  it("never reuses a sequence number when a crash left meta.json behind the log", async () => {
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    await ledger.append({ type: "run.finished", id: "a", account: "default" })
    await ledger.append({ type: "run.finished", id: "b", account: "default" })
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 2 }))
    const next = await ledger.append({ type: "run.finished", id: "c", account: "default" })
    expect(next.seq).toBe(3)
  })

  it("appends to a 50,000-event log reading only its tail, and numbers the event after the last", async () => {
    const dir = temp()
    mkdirSync(dir, { recursive: true })
    const at = "2026-11-17T09:00:00.000Z"
    const lines = Array.from({ length: 50_000 }, (_, index) => `${JSON.stringify({ type: "run.finished", id: `run-${index + 1}`, account: "default", seq: index + 1, at })}\n`)
    writeFileSync(join(dir, "events.jsonl"), lines.join(""))
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 50_001 }))
    const size = statSync(join(dir, "events.jsonl")).size
    expect(size).toBeGreaterThan(4_000_000)
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    for (const id of ["x", "y", "z"]) {
      reads.bytes = 0
      reads.counting = true
      const event = await ledger.append({ type: "run.finished", id, account: "default" })
      reads.counting = false
      // The tail window and meta.json, never the log: a few KiB against a log of megabytes.
      expect(reads.bytes, id).toBeLessThan(16 * 1024)
      expect(event.seq).toBe(50_001 + ["x", "y", "z"].indexOf(id))
    }
    expect((await ledger.eventsSince(50_000, 10)).events.map((event) => [event.seq, event.id])).toEqual([[50_001, "x"], [50_002, "y"], [50_003, "z"]])
  }, 60_000)

  it("after a crash inside an append, the torn line is skipped and never swallows the next event", async () => {
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    for (const id of ["a", "b", "c"]) await ledger.append({ type: "run.finished", id, account: "default" })
    // The crash: half of event 4 reached the log, and meta.json was not updated.
    writeFileSync(join(dir, "events.jsonl"), `${readFileSync(join(dir, "events.jsonl"), "utf8")}{"type":"run.finished","id":"d","acc`)
    const next = await ledger.append({ type: "run.finished", id: "e", account: "default" })
    expect(next.seq).toBe(4)
    expect((await ledger.eventsSince(0, 10)).events.map((event) => [event.seq, event.id])).toEqual([[1, "a"], [2, "b"], [3, "c"], [4, "e"]])
  })

  it("a last event whose newline the crash lost still counts: its number is not reused", async () => {
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    for (const id of ["a", "b", "c"]) await ledger.append({ type: "run.finished", id, account: "default" })
    const log = join(dir, "events.jsonl")
    writeFileSync(log, `${readFileSync(log, "utf8")}${JSON.stringify({ type: "run.finished", id: "d", account: "default", seq: 4, at: "2026-11-17T09:00:00.000Z" })}`)
    const next = await ledger.append({ type: "run.finished", id: "e", account: "default" })
    expect(next.seq).toBe(5)
    const seqs = (await ledger.eventsSince(0, 10)).events.map((event) => event.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  const logLine = (seq: number) => `${JSON.stringify({ type: "run.finished", id: `e${seq}`, account: "default", seq, at: "2026-11-17T09:00:00.000Z" })}\n`

  it("P4 (colab-17): meta behind, a torn line, then an append cut after its leading newline: no number reused", async () => {
    const dir = temp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), logLine(1) + logLine(2) + logLine(3) + `{"type":"run.finished","id":"t","acc` + "\n")
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 3 }))
    const next = await new FileLedger(dir, { ledgerDays: 90 }).append({ type: "run.finished", id: "x", account: "default" })
    expect(next.seq).toBe(4)
  })

  it("P5 (colab-17): meta behind and two torn lines in a row: no number reused", async () => {
    const dir = temp()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, "events.jsonl"), logLine(1) + logLine(2) + logLine(3) + `{"type":"run.finished","id":"t","acc` + `\n{"type":"run.fin`)
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 3 }))
    const next = await new FileLedger(dir, { ledgerDays: 90 }).append({ type: "run.finished", id: "x", account: "default" })
    expect(next.seq).toBe(4)
  })

  it("walks back past many unparseable lines, beyond the first window, to the last one that parses", async () => {
    const dir = temp()
    mkdirSync(dir, { recursive: true })
    const junk = Array.from({ length: 200 }, (_, index) => `{"torn":${index},"x":"${"y".repeat(60)}`).join("\n")
    writeFileSync(join(dir, "events.jsonl"), logLine(1) + logLine(2) + logLine(7) + junk)
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 2 }))
    expect((await new FileLedger(dir, { ledgerDays: 90 }).append({ type: "run.finished", id: "x", account: "default" })).seq).toBe(8)
  })

  it("writes meta.json before the line: a crash between them leaves a gap, never a reuse", async () => {
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    for (const id of ["a", "b"]) await ledger.append({ type: "run.finished", id, account: "default" })
    // The crash: event 3's meta update landed, its line did not.
    writeFileSync(join(dir, "meta.json"), JSON.stringify({ nextSeq: 4 }))
    const next = await ledger.append({ type: "run.finished", id: "c", account: "default" })
    expect(next.seq).toBe(4)
    expect((await ledger.eventsSince(0, 10)).events.map((event) => event.seq)).toEqual([1, 2, 4])
    expect((await ledger.eventsSince(2, 10)).expired).toBe(false)
  })

  it.skipIf(process.getuid?.() === 0)("advances meta.json before it writes the line: a failed append leaves its number unused for good", async () => {
    const dir = temp()
    const ledger = new FileLedger(dir, { ledgerDays: 90 })
    await ledger.append({ type: "run.finished", id: "a", account: "default" })
    chmodSync(join(dir, "events.jsonl"), 0o400)
    await expect(ledger.append({ type: "run.finished", id: "b", account: "default" })).rejects.toThrow(/^LEDGER_UNAVAILABLE: /)
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toEqual({ nextSeq: 3 })
    chmodSync(join(dir, "events.jsonl"), 0o600)
    expect((await ledger.append({ type: "run.finished", id: "c", account: "default" })).seq).toBe(3)
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
