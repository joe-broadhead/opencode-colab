// The `colab.runs` source (src/sources/runs.ts): its cursor, the family's three recurring bugs (the sliding gap, the
// jam, the gap more than once a read), late finishers, the sweep for runs whose writer appended no entry, and
// realistic load — hundreds of runs a day, runs lasting hours, jobs observed hours after they ended, a consumer that
// pauses past the ledger's retention. Every page is checked against the contract by the harness's consumer.
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { MAX_CURSOR_LENGTH } from "@we-the-rebel-alliance/source-contract/cursor"
import { resultProblems, type EventsListResult } from "@we-the-rebel-alliance/source-contract/events"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { FileLedger } from "../../src/ledger/store.js"
import { localOwner, localOwnerOf } from "../../src/sources/owner.js"
import { decodeRunsCursor, encodeRunsCursor, PACKAGE, runsBinding } from "../../src/sources/runs.js"
import { SourcesLedger } from "../fakes/sources-ledger.js"
import { consumerRun, drain, enterpriseJob, HOME, LAB, ourRuntime, sourcesHarness, type Harness } from "../fakes/sources-harness.js"

const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000

/** A harness whose clock starts at `start` (ms). */
function at(start: number, options?: unknown) {
  const h = sourcesHarness(options === undefined ? {} : { options })
  h.fakes.clock.current = new Date(start)
  return h
}
const T0 = Date.parse("2026-11-17T09:00:00.000Z")

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as Error).message
  }
  return "no refusal"
}

describe("the cursor", () => {
  it("round-trips and is bound to the plugin, the source and the account", () => {
    const cursor = encodeRunsCursor(HOME, { q: 42, h: "2026-11-17T09:00:00.000Z", t: "2026-11-17T09:00:00.000Z" })
    expect(decodeRunsCursor(HOME, cursor)).toEqual({ q: 42, h: "2026-11-17T09:00:00.000Z", t: "2026-11-17T09:00:00.000Z" })
    for (const foreign of [
      encodeRunsCursor(LAB, { q: 1, t: "2026-11-17T09:00:00.000Z" }),
      encodeBoundCursor({ plugin: "other-plugin", source: "runs", account: HOME }, { q: 1, t: "2026-11-17T09:00:00.000Z" }),
      encodeBoundCursor({ plugin: PACKAGE, source: "runtimes", account: HOME }, { q: 1, t: "2026-11-17T09:00:00.000Z" }),
      encodeBoundCursor(runsBinding(HOME), { q: -1, t: "2026-11-17T09:00:00.000Z" }),
      encodeBoundCursor(runsBinding(HOME), { q: 1.5, t: "2026-11-17T09:00:00.000Z" }),
      encodeBoundCursor(runsBinding(HOME), { q: 1, t: "yesterday" }),
      encodeBoundCursor(runsBinding(HOME), { q: 1, t: "2026-11-17T09:00:00.000Z", extra: 1 }),
      "not-a-cursor",
    ]) {
      expect(() => decodeRunsCursor(HOME, foreign)).toThrow(/^CURSOR_INVALID: /)
    }
  })

  it("stays far inside the contract's 1,024 characters in the worst case", () => {
    const alias = "a".repeat(64)
    const cursor = encodeRunsCursor(alias, { q: Number.MAX_SAFE_INTEGER, h: "9999-12-31T23:59:59.999Z", t: "9999-12-31T23:59:59.999Z" })
    expect(cursor.length).toBeLessThan(MAX_CURSOR_LENGTH / 3)
  })
})

describe("the local owner", () => {
  it("is the OS user on this computer, in boxd's form", () => {
    expect(localOwnerOf("Ada Lovelace", "Studio-Mac.local")).toEqual({ id: "os-user:ada-lovelace@studio-mac", label: "ada-lovelace on studio-mac" })
    expect(localOwnerOf("", "")).toEqual({ id: "os-user:user@local", label: "user on local" })
  })
})

describe("a read", () => {
  it("asserts colab.events_list on the account, then colab.read on the ledger listing, and nothing else", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "r1", start: T0 - 10 * MIN, end: T0 - 5 * MIN })
    await drain(h.tool, {})
    expect(h.permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.events_list", [HOME]],
      ["colab.read", [`${HOME}:colab.ledger.list`]],
    ])
  })

  it("reads nothing when colab.read is denied, and the denial reaches the caller unchanged", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    h.permission.decide = (request) => {
      if (request.action === "colab.read") throw new Error("denied by the test's rules")
    }
    expect(await refusal(h.tool("events_list", { source: "runs", account: HOME }))).toBe("denied by the test's rules")
    expect(ledger.reads).toEqual({ listRuns: 0, eventsSince: 0, listRuntimes: 0, append: 0 })
  })

  it("names this computer's owner on an empty page, signed in or not: the ledger is local, keyed by alias", async () => {
    const h = at(T0)
    const page = (await h.tool("events_list", { source: "runs", account: HOME })) as EventsListResult
    expect(page.events).toEqual([])
    expect(page.owner).toEqual(localOwner())
    expect(page.owner.id).toMatch(/^os-user:[a-z0-9._-]+@[a-z0-9._-]+$/)
    expect(page.more).toBe(false)
    expect(page.plugin).toBe(PACKAGE)
    expect(resultProblems(page)).toEqual([])
    h.fakes.auth.grants.delete(HOME)
    expect(((await h.tool("events_list", { source: "runs", account: HOME })) as EventsListResult).owner).toEqual(localOwner())
    // The descriptor's id names the same source.
    expect(((await h.tool("events_list", { source: "colab.runs", account: HOME })) as EventsListResult).source).toBe("runs")
  })

  it("refuses another source's name, a scope and a malformed since in the contract's codes", async () => {
    const h = at(T0)
    expect(await refusal(h.tool("events_list", { source: "jobs", account: HOME }))).toMatch(/^SOURCE_UNKNOWN: /)
    expect(await refusal(h.tool("events_list", { source: "runs", account: HOME, scope: { project: "x" } }))).toMatch(/^INPUT_INVALID: /)
    expect(await refusal(h.tool("events_list", { source: "runs", account: HOME, since: "last tuesday" }))).toMatch(/^INPUT_INVALID: /)
  })

  it("lists a finished run in the plugin's words: no cell text, no output, no link", async () => {
    const h = at(T0)
    await ourRuntime(h.ledger, "oc-01jinventedruntime000000000")
    await consumerRun(h.ledger, { runId: "r-words", start: T0 - 42_000, end: T0, notebook: "notebooks/analysis.ipynb", cells: 6, state: "error", errorCode: "KERNEL_DIED", append: true })
    h.fakes.clock.advance(MIN)
    const { events } = await drain(h.tool, {})
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      source: "runs",
      account: HOME,
      external_id: "r-words",
      kind: "x-colab/run",
      occurred_at: new Date(T0).toISOString(),
      title: "Ran 6 cells of analysis.ipynb on T4 GPU — failed (KERNEL_DIED), 42 s",
      text: "",
      url: null,
      thread: "colab-runtime:oc-01jinventedruntime000000000",
      labels: ["backend:colab", "state:error", "code:KERNEL_DIED", "accelerator:T4", "runtime:oc-01jinventedruntime000000000"],
    })
  })

  it("refuses a run whose notebook name is secret-shaped, for good, and moves past it", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "r-secret", start: T0 - MIN, end: T0, notebook: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.ipynb", append: true })
    await consumerRun(h.ledger, { runId: "r-after", start: T0 - MIN, end: T0, append: true })
    h.fakes.clock.advance(MIN)
    const first = await drain(h.tool, { limit: 1 })
    expect(first.refused).toEqual([expect.objectContaining({ external_id: "r-secret", reason: "secret" })])
    expect(first.events.map((event) => event.external_id)).toEqual(["r-after"])
    const again = await drain(h.tool, { cursor: first.cursor })
    expect(again.events).toEqual([])
    expect(again.refused).toEqual([])
  })

  it("never lists another account's runs, and refuses its cursor", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "r-home", start: T0 - MIN, end: T0, append: true })
    await enterpriseJob(h.ledger, { runId: "job-lab", start: T0 - HOUR, end: T0 - MIN })
    h.fakes.clock.advance(MIN)
    const home = await drain(h.tool, { account: HOME })
    const lab = await drain(h.tool, { account: LAB })
    expect(home.events.map((event) => event.external_id)).toEqual(["r-home"])
    expect(lab.events.map((event) => event.external_id)).toEqual(["job-lab"])
    expect(lab.events[0]!.title).toBe("Colab Enterprise job job-lab succeeded, 59 min")
    expect(await refusal(h.tool("events_list", { source: "runs", account: LAB, cursor: home.cursor }))).toMatch(/^CURSOR_INVALID: /)
  })

  it("starts a first read at since, or 24 hours back, and leaves out runs that ended before it", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "r-old", start: T0 - 30 * HOUR, end: T0 - 25 * HOUR, append: true })
    h.fakes.clock.current = new Date(T0)
    await consumerRun(h.ledger, { runId: "r-new", start: T0 - 2 * HOUR, end: T0 - HOUR })
    h.fakes.clock.advance(MIN)
    expect((await drain(h.tool, {})).events.map((event) => event.external_id)).toEqual(["r-new"])
    expect((await drain(h.tool, { since: new Date(T0 - 26 * HOUR).toISOString() })).events.map((event) => event.external_id).sort()).toEqual(["r-new", "r-old"])
  })
})

describe("late finishers", () => {
  it("lists a run that started before the cursor and ends hours later, once", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "long", start: T0, notebook: "train.ipynb" })
    let cursor = (await drain(h.tool, {})).cursor
    // Six hours of short runs while the long one keeps going, read every 10 minutes.
    const seen: string[] = []
    for (let step = 1; step <= 36; step++) {
      h.fakes.clock.advance(10 * MIN)
      await consumerRun(h.ledger, { runId: `short-${step}`, start: h.fakes.clock.now().getTime() - 5 * MIN, end: h.fakes.clock.now().getTime() - MIN })
      const read = await drain(h.tool, { cursor })
      seen.push(...read.events.map((event) => event.external_id))
      expect(read.gaps).toEqual([])
      cursor = read.cursor
    }
    await consumerRun(h.ledger, { runId: "long", start: T0, end: h.fakes.clock.now().getTime(), notebook: "train.ipynb" })
    h.fakes.clock.advance(MIN)
    const last = await drain(h.tool, { cursor })
    seen.push(...last.events.map((event) => event.external_id))
    expect(seen.filter((id) => id === "long")).toHaveLength(1)
    expect(new Set(seen).size).toBe(37)
    expect(last.events.find((event) => event.external_id === "long")!.title).toContain("6 h")
  })

  it("lists a job whose end Google recorded hours before the plugin observed it, behind nothing", async () => {
    const h = at(T0)
    await enterpriseJob(h.ledger, { runId: "job-late", start: T0 - 8 * HOUR })
    let cursor = (await drain(h.tool, { account: LAB })).cursor
    // Other jobs end and are read; then a read observes job-late's end, five hours after Google's endTime.
    for (let step = 1; step <= 3; step++) {
      h.fakes.clock.advance(HOUR)
      await enterpriseJob(h.ledger, { runId: `job-${step}`, start: h.fakes.clock.now().getTime() - 30 * MIN, end: h.fakes.clock.now().getTime() - 10 * MIN })
      const read = await drain(h.tool, { account: LAB, cursor })
      cursor = read.cursor
    }
    await enterpriseJob(h.ledger, { runId: "job-late", start: T0 - 8 * HOUR, end: T0 - 2 * HOUR, state: "failed" })
    await enterpriseJob(h.ledger, { runId: "job-4", start: h.fakes.clock.now().getTime() - 20 * MIN, end: h.fakes.clock.now().getTime() - 5 * MIN })
    const read = await drain(h.tool, { account: LAB, cursor })
    // The page is oldest first by when each ended, even though job-late became visible last but one.
    expect(read.events.map((event) => event.external_id)).toEqual(["job-late", "job-4"])
    expect(read.events[0]!.occurred_at).toBe(new Date(T0 - 2 * HOUR).toISOString())
    expect(read.gaps).toEqual([])
  })
})

describe("the three recurring bugs", () => {
  it("the jam: 5,000 runs ending in the same millisecond drain at limit 7, each once, with no gap", async () => {
    const h = at(T0)
    const cursor0 = (await drain(h.tool, {})).cursor
    for (let index = 0; index < 5_000; index++) await consumerRun(h.ledger, { runId: `tie-${String(index).padStart(4, "0")}`, start: T0 - MIN, end: T0, append: index % 2 === 0 })
    h.fakes.clock.advance(MIN)
    const read = await drain(h.tool, { cursor: cursor0, limit: 7 })
    const ids = read.events.map((event) => event.external_id)
    expect(ids).toHaveLength(5_000)
    expect(new Set(ids).size).toBe(5_000)
    expect(read.gaps).toEqual([])
    expect(read.pages).toBe(Math.ceil(5_000 / 7))
  }, 120_000)

  it("the gap once per read: an expired cursor read one event a page answers exactly one gap", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "seen", start: T0 - MIN, end: T0, append: true })
    h.fakes.clock.advance(MIN)
    const first = await drain(h.tool, {})
    // 100 days pass with a run every 6 hours; the ledger prunes daily.
    for (let day = 1; day <= 100; day++) {
      for (let slot = 0; slot < 4; slot++) {
        h.fakes.clock.advance(6 * HOUR)
        await consumerRun(h.ledger, { runId: `d${day}-${slot}`, start: h.fakes.clock.now().getTime() - 30 * MIN, end: h.fakes.clock.now().getTime() - MIN, append: true })
      }
      await h.ledger.prune(h.fakes.clock.now())
    }
    const read = await drain(h.tool, { cursor: first.cursor, limit: 1 })
    expect(read.gaps).toEqual([{ reason: "expired", since: new Date(T0).toISOString() }])
    // Everything the ledger still keeps is listed: the last 90 days, nothing twice.
    const kept = (await h.ledger.listRuns({ account: HOME })).filter((run) => run.runId !== "seen").map((run) => run.runId)
    expect(read.events.map((event) => event.external_id).sort()).toEqual(kept.sort())
    expect(read.pages).toBe(kept.length)
  })

  it("the sliding gap: the gap's since is the cursor's, not now, and the restart lists what arrives after", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "seen", start: T0 - MIN, end: T0, append: true })
    h.fakes.clock.advance(MIN)
    const first = await drain(h.tool, {})
    // A run ends after the cursor and is pruned before anyone reads it: that is the history the gap announces.
    h.fakes.clock.advance(DAY)
    await consumerRun(h.ledger, { runId: "lost", start: h.fakes.clock.now().getTime() - HOUR, end: h.fakes.clock.now().getTime(), append: true })
    h.fakes.clock.advance(95 * DAY)
    await h.ledger.prune(h.fakes.clock.now())
    // The same expired cursor read an hour apart answers the same since.
    const a = (await h.tool("events_list", { source: "runs", account: HOME, cursor: first.cursor, limit: 1 })) as EventsListResult
    h.fakes.clock.advance(HOUR)
    await consumerRun(h.ledger, { runId: "after-gap", start: h.fakes.clock.now().getTime() - 5 * MIN, end: h.fakes.clock.now().getTime() - MIN, append: true })
    const b = (await h.tool("events_list", { source: "runs", account: HOME, cursor: first.cursor, limit: 1 })) as EventsListResult
    expect(a.gap).toEqual({ reason: "expired", since: new Date(T0).toISOString() })
    expect(b.gap).toEqual(a.gap)
    // Minutes after the gap, a run ends: the restart cursor lists it, with no second gap.
    h.fakes.clock.advance(5 * MIN)
    await consumerRun(h.ledger, { runId: "minutes-later", start: h.fakes.clock.now().getTime() - 2 * MIN, end: h.fakes.clock.now().getTime() - MIN, append: true })
    const next = await drain(h.tool, { cursor: b.cursor })
    expect(next.gaps).toEqual([])
    expect(next.events.map((event) => event.external_id)).toEqual(["minutes-later"])
  })

  it("a ledger that was deleted, or one that grew past the cursor again, answers one gap and never a refusal", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    for (let index = 0; index < 5; index++) await consumerRun(ledger, { runId: `before-${index}`, start: T0 - MIN, end: T0, append: true })
    h.fakes.clock.advance(MIN)
    const first = await drain(h.tool, {})
    ledger.reset()
    // Fewer entries than the cursor's number: the cursor is past the newest.
    await consumerRun(ledger, { runId: "after-1", start: h.fakes.clock.now().getTime() - MIN, end: h.fakes.clock.now().getTime(), append: true })
    const small = await drain(h.tool, { cursor: first.cursor })
    expect(small.gaps).toEqual([{ reason: "expired", since: first.events.at(-1)!.occurred_at }])
    expect(small.events.map((event) => event.external_id)).toEqual(["after-1"])
    // Deleted again and regrown past the cursor's number: the entry at the cursor has another time.
    ledger.reset()
    h.fakes.clock.advance(MIN)
    for (let index = 0; index < 8; index++) await consumerRun(ledger, { runId: `regrown-${index}`, start: h.fakes.clock.now().getTime() - MIN, end: h.fakes.clock.now().getTime(), append: true })
    const regrown = await drain(h.tool, { cursor: small.cursor })
    expect(regrown.gaps).toHaveLength(1)
    expect(regrown.events.map((event) => event.external_id)).toEqual(Array.from({ length: 8 }, (_, index) => `regrown-${index}`))
  })
})

describe("the sweep: final runs no entry announces", () => {
  it("lists package D's runs, which append no entry, once, however often it is read", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    await consumerRun(ledger, { runId: "d-1", start: T0 - 5 * MIN, end: T0 - MIN })
    const one = await drain(h.tool, {})
    const two = await drain(h.tool, { cursor: one.cursor })
    const three = await drain(h.tool, {})
    expect(one.events.map((event) => event.external_id)).toEqual(["d-1"])
    expect(two.events).toEqual([])
    expect(three.events.map((event) => event.external_id)).toEqual(["d-1"])
    expect(ledger.events.filter((entry) => entry.type === "run.finished")).toHaveLength(1)
  })

  it("lists a run once when two processes swept it, or a writer appended after the sweep", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    const cursor = (await drain(h.tool, {})).cursor
    // E wrote the job's end; a sweep in another process ran before E's own append.
    await enterpriseJob(ledger, { runId: "race", account: HOME, start: T0 - HOUR, end: T0 - MIN, append: false })
    const swept = await drain(h.tool, { cursor })
    await ledger.append({ type: "run.finished", id: "race", account: HOME })
    await ledger.append({ type: "run.finished", id: "race", account: HOME })
    const after = await drain(h.tool, { cursor: swept.cursor })
    expect(swept.events.map((event) => event.external_id)).toEqual(["race"])
    expect(after.events).toEqual([])
  })

  it("lists a retried Enterprise create that reuses a settled job's id as its own run", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    // The first create did not land; E settles it as failed and appends run.finished (abandonJobCreate).
    await enterpriseJob(ledger, { runId: "job-x", start: T0 - 2 * MIN, end: T0 - MIN, state: "failed" })
    const first = await drain(h.tool, { account: LAB })
    // The retry writes a fresh record with the same id and a new start; it runs for an hour.
    h.fakes.clock.advance(MIN)
    await enterpriseJob(ledger, { runId: "job-x", start: h.fakes.clock.now().getTime() })
    h.fakes.clock.advance(HOUR)
    await enterpriseJob(ledger, { runId: "job-x", start: T0 + MIN, end: h.fakes.clock.now().getTime() })
    const second = await drain(h.tool, { account: LAB, cursor: first.cursor })
    expect(first.events.map((event) => event.title)).toEqual(["Colab Enterprise job job-x failed, 1 min"])
    expect(second.events.map((event) => event.title)).toEqual(["Colab Enterprise job job-x succeeded, 1 h"])
  })

  it("never lists a run that is still running or detached", async () => {
    const h = at(T0)
    await consumerRun(h.ledger, { runId: "running", start: T0 - HOUR })
    await h.ledger.putRun({ ...(await h.ledger.getRun("running"))!, runId: "detached", state: "detached" })
    expect((await drain(h.tool, {})).events).toEqual([])
  })
})

describe("realistic load", () => {
  /**
   * Fourteen days of 300 runs a day on two accounts: consumer runs of a few seconds to eight hours (half of their
   * writers append no entry, as package D's), Enterprise jobs of up to six hours that the plugin observes up to six hours
   * after Google's endTime, and a consumer that reads each account every hour at limit 50.
   */
  it("lists every run once, with no gap, at 300 runs a day read hourly", async () => {
    const h = at(T0)
    const ledger = h.ledger as SourcesLedger
    let seed = 7
    const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)
    const pending: { readonly at: number; readonly write: () => Promise<unknown> }[] = []
    const cursors: Record<string, string | undefined> = { [HOME]: undefined, [LAB]: undefined }
    const listed: Record<string, string[]> = { [HOME]: [], [LAB]: [] }
    const started: Record<string, Set<string>> = { [HOME]: new Set(), [LAB]: new Set() }
    for (const account of [HOME, LAB]) cursors[account] = (await drain(h.tool, { account })).cursor
    let made = 0
    for (let hour = 0; hour < 14 * 24; hour++) {
      // 12 or 13 runs start this hour; each is written now and finishes later, as the clock reaches it.
      for (let index = 0; index < 12 + (hour % 2); index++) {
        const id = `run-${made++}`
        const start = h.fakes.clock.now().getTime() + Math.floor(random() * HOUR)
        if (random() < 0.8) {
          const length = random() < 0.9 ? 5_000 + Math.floor(random() * 20 * MIN) : HOUR + Math.floor(random() * 7 * HOUR)
          started[HOME]!.add(id)
          pending.push({ at: start, write: () => consumerRun(ledger, { runId: id, start }) })
          pending.push({ at: start + length, write: () => consumerRun(ledger, { runId: id, start, end: start + length, append: random() < 0.5 }) })
        } else {
          const length = 10 * MIN + Math.floor(random() * 6 * HOUR)
          started[LAB]!.add(id)
          pending.push({ at: start, write: () => enterpriseJob(ledger, { runId: id, start }) })
          pending.push({ at: start + length + Math.floor(random() * 6 * HOUR), write: () => enterpriseJob(ledger, { runId: id, start, end: start + length }) })
        }
      }
      pending.sort((a, b) => a.at - b.at)
      const hourEnd = h.fakes.clock.now().getTime() + HOUR
      while (pending.length > 0 && pending[0]!.at <= hourEnd) {
        const next = pending.shift()!
        h.fakes.clock.current = new Date(Math.max(next.at, h.fakes.clock.now().getTime()))
        await next.write()
      }
      h.fakes.clock.current = new Date(hourEnd)
      for (const account of [HOME, LAB]) {
        const before = { ...ledger.reads }
        const read = await drain(h.tool, { account, cursor: cursors[account], limit: 50 })
        expect(read.gaps).toEqual([])
        // Each page costs one run listing, one runtime listing and one log read (two when it swept).
        expect(ledger.reads.listRuns - before.listRuns).toBe(read.pages)
        expect(ledger.reads.eventsSince - before.eventsSince).toBeLessThanOrEqual(2 * read.pages)
        listed[account]!.push(...read.events.map((event) => event.external_id))
        cursors[account] = read.cursor
      }
    }
    // Finish everything still running, then one last read.
    for (const next of pending.sort((a, b) => a.at - b.at)) {
      h.fakes.clock.current = new Date(Math.max(next.at, h.fakes.clock.now().getTime()))
      await next.write()
    }
    for (const account of [HOME, LAB]) {
      const read = await drain(h.tool, { account, cursor: cursors[account], limit: 50 })
      expect(read.gaps).toEqual([])
      listed[account]!.push(...read.events.map((event) => event.external_id))
      expect(listed[account]!.length).toBe(started[account]!.size)
      expect(new Set(listed[account]).size).toBe(started[account]!.size)
      expect(new Set(listed[account])).toEqual(started[account])
    }
    expect(made).toBeGreaterThanOrEqual(14 * 300)
  }, 120_000)

  it("a consumer away 120 days gets one gap, then everything the ledger kept, and an active one never gaps", async () => {
    const h = at(T0)
    const away = (await drain(h.tool, {})).cursor
    let active = away
    const activeListed: string[] = []
    let made = 0
    for (let day = 0; day < 120; day++) {
      for (let slot = 0; slot < 50; slot++) {
        h.fakes.clock.advance(Math.floor(DAY / 50))
        const now = h.fakes.clock.now().getTime()
        await consumerRun(h.ledger, { runId: `r${made++}`, start: now - 3 * HOUR, end: now })
      }
      await h.ledger.prune(h.fakes.clock.now())
      const read = await drain(h.tool, { cursor: active, limit: 200 })
      expect(read.gaps).toEqual([])
      activeListed.push(...read.events.map((event) => event.external_id))
      active = read.cursor
    }
    expect(activeListed).toHaveLength(made)
    expect(new Set(activeListed).size).toBe(made)
    const back = await drain(h.tool, { cursor: away, limit: 500 })
    expect(back.gaps).toHaveLength(1)
    const kept = (await h.ledger.listRuns({ account: HOME })).map((run) => run.runId)
    expect(back.events.map((event) => event.external_id).sort()).toEqual(kept.sort())
  }, 120_000)
})

describe("on the file ledger itself", () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const fileHarness = (): Harness => {
    const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "colab-g-ledger-"))
    dirs.push(dir)
    return sourcesHarness({ ledger: (fakes, ledgerDays) => new FileLedger(dir, { ledgerDays, clock: fakes.clock }) })
  }

  it("drains a tie, sweeps D's runs, and gaps once after pruning, as the strict fake does", async () => {
    const h = fileHarness()
    h.fakes.clock.current = new Date(T0)
    const start = (await drain(h.tool, {})).cursor
    for (let index = 0; index < 60; index++) await consumerRun(h.ledger, { runId: `f-${index}`, start: T0 - MIN, end: T0, append: index % 3 === 0 })
    h.fakes.clock.advance(MIN)
    const read = await drain(h.tool, { cursor: start, limit: 7 })
    expect(read.events.map((event) => event.external_id).sort()).toEqual(Array.from({ length: 60 }, (_, index) => `f-${index}`).sort())
    expect(read.gaps).toEqual([])
    h.fakes.clock.advance(100 * DAY)
    await consumerRun(h.ledger, { runId: "f-late", start: h.fakes.clock.now().getTime() - MIN, end: h.fakes.clock.now().getTime(), append: true })
    await h.ledger.prune(h.fakes.clock.now())
    const after = await drain(h.tool, { cursor: start, limit: 1 })
    expect(after.gaps).toHaveLength(1)
    expect(after.events.map((event) => event.external_id)).toEqual(["f-late"])
  })
})
