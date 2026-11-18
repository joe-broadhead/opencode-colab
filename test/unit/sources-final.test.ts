// One definition of "final" (colab-16, LOW 4): the ledger's own `run.finished` announcement in `putRun` and the
// `colab.runs` listing (with its sweep) agree on every record. A record whose `endedAt` does not parse is announced by
// neither and listed by neither; a well-formed final record is announced once and listed once — on Day 0's in-memory
// ledger and on the file ledger.
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileLedger, isFinal } from "../../src/ledger/store.js"
import type { Ledger, RunRecord } from "../../src/ports.js"
import { isFinal as sourcesFinal } from "../../src/sources/runs.js"
import { MemoryLedger } from "../fakes/index.js"
import { drain, HOME, sourcesHarness } from "../fakes/sources-harness.js"

const T0 = Date.parse("2026-11-17T09:00:00.000Z")
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const run = (runId: string, endedAt: string | undefined, state: RunRecord["state"] = "ok"): RunRecord => ({
  runId,
  account: HOME,
  backend: "colab",
  cellIds: ["c0"],
  startedAt: new Date(T0 - 60_000).toISOString(),
  ...(endedAt !== undefined ? { endedAt } : {}),
  state,
  outputPaths: [],
})

describe("final", () => {
  it("is one definition, shared by the ledger and the source", () => {
    expect(sourcesFinal).toBe(isFinal)
    expect(isFinal(run("a", new Date(T0).toISOString()))).toBe(true)
    expect(isFinal(run("b", "not a time"))).toBe(false)
    expect(isFinal(run("c", new Date(T0).toISOString(), "detached"))).toBe(false)
    expect(isFinal(run("d", undefined, "error"))).toBe(false)
  })

  for (const kind of ["memory", "file"] as const) {
    it(`a record with an unparsable end is neither announced nor listed, and a well-formed one is both, once (${kind} ledger)`, async () => {
      const dir = kind === "file" ? mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "colab-g-final-")) : ""
      if (dir) dirs.push(dir)
      const h = sourcesHarness({ ledger: (fakes, ledgerDays) => (kind === "file" ? new FileLedger(dir, { ledgerDays, clock: fakes.clock }) : new MemoryLedger(fakes.clock)) })
      h.fakes.clock.current = new Date(T0)
      const ledger: Ledger = h.ledger
      await ledger.putRun(run("garbled", "not a time"))
      await ledger.putRun(run("good", new Date(T0).toISOString()))
      const announced = (await ledger.eventsSince(0, 100)).events.filter((entry) => entry.type === "run.finished").map((entry) => entry.id)
      expect(announced).toEqual(["good"])
      h.fakes.clock.advance(60_000)
      const read = await drain(h.tool, { account: HOME })
      expect(read.events.map((event) => event.external_id)).toEqual(["good"])
      // The source's sweep agrees: it appends nothing for the garbled record either.
      const after = (await ledger.eventsSince(0, 100)).events.filter((entry) => entry.type === "run.finished").map((entry) => entry.id)
      expect(after).toEqual(["good"])
    })
  }
})
