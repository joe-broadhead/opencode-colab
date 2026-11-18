// `colab.runs` against writers racing its reads (review #15, M1). A read makes several ledger calls (the log, the run
// records, the runtimes, the sweep's appends, the log and records again). A run that ends at **any** of those points,
// written the way package E writes (the final record, then `run.finished`) or the way package D writes (the final
// record only), must be listed exactly once over the next reads, with no gap — on the strict in-memory ledger and on the
// file ledger. And two processes — separate file-ledger instances on one folder, as two OpenCode processes are —
// writing and reading at once lose nothing and list nothing twice.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileLedger } from "../../src/ledger/store.js"
import type { Ledger, RunRecord } from "../../src/ports.js"
import { SWEEP_MAX } from "../../src/sources/runs.js"
import { SourcesLedger } from "../fakes/sources-ledger.js"
import { consumerRun, drain, enterpriseJob, HOME, sourcesHarness, type Harness } from "../fakes/sources-harness.js"

const T0 = Date.parse("2026-11-17T09:00:00.000Z")
const MIN = 60_000

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const folder = () => {
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "colab-g-race-"))
  dirs.push(dir)
  return dir
}

type Writer = "E" | "D"
const KINDS: readonly ("memory" | "file")[] = ["memory", "file"]

/**
 * A ledger that runs `inject` once, just before its `at`-th call (0-based, every method counted), then answers from the
 * real ledger: a writer in another process landing at exactly that point of the read.
 */
function racing(real: Ledger, at: number, inject: () => Promise<void>): { ledger: Ledger; calls: () => number; fire: () => Promise<void> } {
  let count = 0
  let done = false
  const fire = async () => {
    if (done) return
    done = true
    await inject()
  }
  const ledger = new Proxy(real, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver)
      if (typeof value !== "function") return value
      return async (...args: unknown[]) => {
        if (count++ === at) await fire()
        return (value as (...a: unknown[]) => unknown).apply(target, args)
      }
    },
  }) as Ledger
  return { ledger, calls: () => count, fire }
}

/**
 * A writer from before the ledger announced runs itself (Day 0's `putRun` appends `run.finished` since contract #16):
 * it writes the final record and nothing else — on the file ledger, the record file itself, as an older plugin
 * version left it; the strict in-memory ledger's `putRun` never appends. That is the run only the sweep can list.
 */
function olderWriter(kind: "memory" | "file", dir: string, real: () => Ledger): Ledger {
  if (kind === "memory") return real()
  return {
    async putRun(record: RunRecord) {
      mkdirSync(join(dir, "runs"), { recursive: true, mode: 0o700 })
      writeFileSync(join(dir, "runs", `${record.runId}.json`), `${JSON.stringify(record)}\n`, { mode: 0o600 })
    },
  } as unknown as Ledger
}

function harnessOn(kind: "memory" | "file", wrap?: (real: Ledger) => Ledger): { h: Harness; real: () => Ledger; older: () => Ledger } {
  let real: Ledger | undefined
  const dir = kind === "file" ? folder() : ""
  const h = sourcesHarness({
    ledger: (fakes, ledgerDays) => {
      real = kind === "file" ? new FileLedger(dir, { ledgerDays, clock: fakes.clock }) : new SourcesLedger(fakes.clock, ledgerDays)
      return wrap ? wrap(real) : real
    },
  })
  h.fakes.clock.current = new Date(T0)
  return { h, real: () => real!, older: () => olderWriter(kind, dir, () => real!) }
}

async function finish(ledger: Ledger, writer: Writer, end: number) {
  if (writer === "E") await enterpriseJob(ledger, { runId: "racer", account: HOME, start: T0 - 30 * MIN, end })
  else await consumerRun(ledger, { runId: "racer", start: T0 - 30 * MIN, end })
}

describe("a run that ends during a read", () => {
  for (const kind of KINDS) {
    for (const writer of ["E", "D"] as const) {
      for (const sweeping of [false, true]) {
        it(`is listed once, whichever ledger call of the read it lands before (${kind} ledger, ${writer}'s writer, ${sweeping ? "a read that sweeps" : "no sweep"})`, async () => {
          // How many ledger calls one read makes, sweep included: measured, so every point stays covered as the code moves.
          const probe = harnessOn(kind)
          if (sweeping) await consumerRun(probe.older(), { runId: "orphan", start: T0 - 2 * MIN, end: T0 - MIN })
          const counted = racing(probe.real(), -1, async () => undefined)
          const counter = sourcesHarness({ ledger: () => counted.ledger })
          counter.fakes.clock.current = new Date(T0)
          await counter.tool("events_list", { source: "runs", account: HOME })
          const points = counted.calls()
          expect(points).toBeGreaterThanOrEqual(sweeping ? 6 : 3)
          for (let at = 0; at < points; at++) {
            const { h, real, older } = harnessOn(kind)
            if (writer === "E") await enterpriseJob(real(), { runId: "racer", account: HOME, start: T0 - 30 * MIN })
            else await consumerRun(real(), { runId: "racer", start: T0 - 30 * MIN })
            const first = await drain(h.tool, {})
            // A run an older writer finished with no entry, so the raced read sweeps (and reads the log and records twice).
            if (sweeping) await consumerRun(older(), { runId: "orphan", start: T0 - 2 * MIN, end: T0 - MIN })
            h.fakes.clock.current = new Date(T0 + 2 * MIN)
            // The next read: the run ends just before the read's `at`-th ledger call.
            const armed = racing(real(), at, () => finish(real(), writer, T0 + MIN))
            const raced = sourcesHarness({ ledger: () => armed.ledger })
            raced.fakes.clock.current = new Date(T0 + 2 * MIN)
            const listed = first.events.map((event) => event.external_id)
            const reads = [await drain(raced.tool, { cursor: first.cursor })]
            await armed.fire()
            reads.push(await drain(h.tool, { cursor: reads[0]!.cursor }))
            reads.push(await drain(h.tool, { cursor: reads[1]!.cursor }))
            for (const read of reads) listed.push(...read.events.map((event) => event.external_id))
            expect(listed.filter((id) => id === "racer"), `racer at call ${at}`).toEqual(["racer"])
            expect(listed.filter((id) => id === "orphan"), `orphan at call ${at}`).toEqual(sweeping ? ["orphan"] : [])
            expect(reads.flatMap((read) => read.gaps), `at call ${at}`).toEqual([])
          }
        })
      }
    }
  }
})

describe("two processes", () => {
  it("one writing runs in both writers' shapes while two others read and sweep: each reader lists every run once", async () => {
    const dir = folder()
    // One machine, one clock: every process's ledger stamps entries from it, and it moves as runs end.
    let now = T0
    const clock = { now: () => new Date(now) }
    const writerSide = sourcesHarness({ ledger: (_fakes, ledgerDays) => new FileLedger(dir, { ledgerDays, clock }) })
    const readers = [0, 1].map(() => sourcesHarness({ ledger: (_fakes, ledgerDays) => new FileLedger(dir, { ledgerDays, clock }) }))
    for (const side of [writerSide, ...readers]) side.fakes.clock.current = new Date(T0)
    const cursors = await Promise.all(readers.map(async (reader) => (await drain(reader.tool, {})).cursor))
    const listed: string[][] = [[], []]
    const total = 120
    const writing = (async () => {
      for (let index = 0; index < total; index++) {
        const runId = `p-${String(index).padStart(3, "0")}`
        const end = T0 + index * 1000
        now = end + 1
        if (index % 3 === 0) await enterpriseJob(writerSide.ledger, { runId, account: HOME, start: end - MIN, end })
        else await consumerRun(writerSide.ledger, { runId, start: end - MIN, end, append: index % 3 === 1 })
        if (index % 7 === 0) await new Promise((resolve) => setTimeout(resolve, 1))
      }
    })()
    const reading = readers.map(async (reader, which) => {
      for (let round = 0; round < 25; round++) {
        const read = await drain(reader.tool, { cursor: cursors[which], limit: 9 })
        expect(read.gaps).toEqual([])
        listed[which]!.push(...read.events.map((event) => event.external_id))
        cursors[which] = read.cursor
        await new Promise((resolve) => setTimeout(resolve, 2))
      }
    })
    await Promise.all([writing, ...reading])
    for (const [which, reader] of readers.entries()) {
      const read = await drain(reader.tool, { cursor: cursors[which] })
      expect(read.gaps).toEqual([])
      listed[which]!.push(...read.events.map((event) => event.external_id))
      expect(listed[which]!.length, `reader ${which}`).toBe(total)
      expect(new Set(listed[which]).size, `reader ${which}`).toBe(total)
    }
  }, 60_000)
})

describe("the sweep's bound", () => {
  it(`appends at most ${SWEEP_MAX} entries a read, and the rest are listed by the next reads, each once`, async () => {
    const { h, real } = harnessOn("memory")
    const cursor = (await drain(h.tool, {})).cursor
    const backlog = 2 * SWEEP_MAX + 50
    for (let index = 0; index < backlog; index++) await consumerRun(real(), { runId: `b-${index}`, start: T0 - 2 * MIN, end: T0 - MIN + index })
    const ledger = real() as SourcesLedger
    const listed: string[] = []
    let next = cursor
    const appendsPerRead: number[] = []
    for (let read = 0; read < 4; read++) {
      const before = ledger.reads.append
      const page = await drain(h.tool, { cursor: next, limit: 500 })
      appendsPerRead.push(ledger.reads.append - before)
      listed.push(...page.events.map((event) => event.external_id))
      expect(page.gaps).toEqual([])
      next = page.cursor
    }
    expect(appendsPerRead).toEqual([SWEEP_MAX, SWEEP_MAX, 50, 0])
    expect(listed).toHaveLength(backlog)
    expect(new Set(listed).size).toBe(backlog)
  })
})
