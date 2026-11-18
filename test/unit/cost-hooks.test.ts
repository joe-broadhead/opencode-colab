// The three hooks (design §8.4, boxd §C.4): a ≤ 200-character context line on the tail of `messages` only when a runtime
// of ours is running and the coarse fingerprint changed; a compaction part keeping the runtime ids; and an idle note
// only when money is burning, automation will not handle it, the fingerprint changed, at most twice an hour and never
// in the execution its own note started. `system` is never touched.
import { describe, expect, it } from "vitest"
import {
  appendToTail,
  compactionLine,
  contextLine,
  idleNote,
  registerHooks,
  shouldNoteIdle,
  snapshotFingerprint,
  snapshotReader,
  type HookSnapshot,
} from "../../src/cost/hooks.js"
import { loadOptions } from "../../src/options.js"
import { FakeClock, MemoryLedger, T4 } from "../fakes/index.js"
import { RecordingHooks } from "../fakes/cost-fakes.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")

const snapshot = (overrides: Partial<HookSnapshot> = {}): HookSnapshot => ({
  runtimes: [{ id: "oc-01jcosthook", spec: "T4 GPU", runningMinutes: 90 }],
  activeRuns: 0,
  runtimeHoursToday: 1.5,
  ...overrides,
})

describe("the context line", () => {
  it("is nothing when no runtime of ours runs, and at most 200 characters when one does", () => {
    expect(contextLine(snapshot({ runtimes: [] }), "on")).toBeUndefined()
    const line = contextLine(snapshot(), "on", 'colab_plan({ action: "runtime.delete", params: { runtime: "oc-01jcosthook" } })')
    expect(line).toBeDefined()
    expect(line!.length).toBeLessThanOrEqual(200)
    expect(line).toContain("colab:")
    expect(line).toMatch(/runtime/)
  })

  it("fingerprints coarse figures, so a quiet fleet is byte-identical", () => {
    expect(snapshotFingerprint(snapshot())).toBe(snapshotFingerprint(snapshot()))
    expect(snapshotFingerprint(snapshot())).not.toBe(snapshotFingerprint(snapshot({ activeRuns: 1 })))
    expect(snapshotFingerprint(snapshot())).not.toBe(snapshotFingerprint(snapshot({ runtimes: [] })))
  })
})

describe("the tail edit", () => {
  const message = (role: string, text: string) => ({ role, content: [{ type: "text" as const, text }] })

  it("appends to the newest user message and leaves everything before it, and system, as it was", () => {
    const system = [{ type: "text" as const, text: "the system prompt" }]
    const messages = [message("user", "hello"), message("assistant", "hi"), message("user", "again")]
    const before = JSON.stringify(messages.slice(0, 2))
    appendToTail(messages, "colab: one line")
    expect(system).toEqual([{ type: "text", text: "the system prompt" }])
    expect(JSON.stringify(messages.slice(0, 2))).toBe(before)
    expect(messages[2]!.content.map((part) => part.text)).toEqual(["again", "colab: one line"])
  })

  it("adds one user message after a tool message, holding only the line", () => {
    const messages = [message("user", "hello"), message("tool", "tool output")]
    appendToTail(messages, "colab: one line")
    expect(messages).toHaveLength(3)
    expect(messages[2]).toEqual({ role: "user", content: [{ type: "text", text: "colab: one line" }] })
  })
})

describe("the compaction part", () => {
  it("names up to ten ids, says how many more, and points at colab_runtimes", () => {
    expect(compactionLine([])).toBeUndefined()
    const line = compactionLine(Array.from({ length: 13 }, (_, index) => `oc-${index}`))!
    expect(line).toContain("oc-0")
    expect(line).toContain("oc-9")
    expect(line).not.toContain("oc-10")
    expect(line).toContain("and 3 more")
    expect(line).toContain("colab_runtimes")
  })
})

describe("the idle check", () => {
  const idle = (overrides: Partial<Parameters<typeof shouldNoteIdle>[0]> = {}) =>
    shouldNoteIdle({ snapshot: snapshot(), automation: "off (access)", idleMinutes: 20, now: NOW.getTime(), background: 0, ...overrides })

  it("speaks only when money is burning and automation will not handle it", () => {
    expect(idle()).toBe(true)
    expect(idle({ automation: "on" })).toBe(false)
    expect(idle({ automation: "on (consent)" })).toBe(false)
    expect(idle({ automation: "not-owner" })).toBe(false)
    expect(idle({ snapshot: snapshot({ runtimes: [] }) })).toBe(false)
    expect(idle({ snapshot: snapshot({ activeRuns: 1 }) })).toBe(false)
    expect(idle({ snapshot: snapshot({ runtimes: [{ id: "oc-01jcosthook", spec: "T4 GPU", runningMinutes: 5 }] }) })).toBe(false)
    expect(idle({ background: 1 })).toBe(false)
  })

  it("never repeats an unchanged fingerprint, and speaks at most twice an hour", () => {
    const last = { fingerprint: snapshotFingerprint(snapshot()), at: NOW.getTime() - 31 * 60_000 }
    expect(idle({ last })).toBe(false)
    expect(idle({ last: { ...last, fingerprint: "different" } })).toBe(true)
    expect(idle({ last: { fingerprint: "different", at: NOW.getTime() - 10 * 60_000 } })).toBe(false)
  })

  it("names the count, the hours and one call", () => {
    const line = idleNote(snapshot(), "off (access)")
    expect(line).toContain("1 runtime")
    expect(line).toContain("1.5 runtime-hours")
    expect(line).toContain("off at this access level")
    expect(line).toContain("/colab-cleanup")
    expect(line).toContain('colab_plan({ action: "runtime.delete", params: { runtime: "oc-01jcosthook" } })')
  })
})

describe("the snapshot", () => {
  it("comes from the ledger, cached: two calls inside the cache read once", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime({ id: "oc-01jcosthook", account: "default", backend: "colab", spec: T4, createdAt: "2026-11-17T10:00:00.000Z", nonce: "n1", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready" })
    const read = snapshotReader({ options: { access: "all", automation: "auto", autoReleaseMinutes: 20 }, ledger, clock })
    const first = await read()
    expect(first.runtimes).toHaveLength(1)
    expect(first.runtimeHoursToday).toBeCloseTo(2, 5)
    // A record written after the cached read is not seen until the cache expires.
    await ledger.putRuntime({ id: "oc-2", account: "default", backend: "colab", spec: T4, createdAt: "2026-11-17T11:00:00.000Z", nonce: "n2", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready" })
    expect((await read()).runtimes).toHaveLength(1)
    clock.advance(11_000)
    expect((await read()).runtimes).toHaveLength(2)
  })
})

describe("registration", () => {
  async function hooks(options: unknown = { access: "ask-changes" }) {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime({ id: "oc-01jcosthook", account: "default", backend: "colab", spec: T4, createdAt: "2026-11-17T10:00:00.000Z", nonce: "n1", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready" })
    const session = new RecordingHooks()
    const registration = await registerHooks({ session: session as never }, { options: await loadOptions(options), ledger, clock })
    return { clock, ledger, session, registration }
  }

  const contextInput = (sessionID = "ses_1") => ({ sessionID, messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }], system: [] })

  it("registers all three, adds the context line once per fingerprint, and keeps the compaction part", async () => {
    const world = await hooks()
    expect(world.session.registered.sort()).toEqual(["compaction", "context", "experimental.idle"])

    const first = contextInput()
    await world.session.fire("context", first)
    expect(first.messages).toHaveLength(1)
    expect(first.messages[0]!.content).toHaveLength(2)
    const second = contextInput()
    await world.session.fire("context", second)
    expect(second.messages[0]!.content).toHaveLength(1)

    const compaction = contextInput()
    await world.session.fire("compaction", compaction)
    expect(compaction.messages[0]!.content.at(-1)!.text).toContain("colab_runtimes")
    // After a compaction the context line speaks again.
    const third = contextInput()
    await world.session.fire("context", third)
    expect(third.messages[0]!.content).toHaveLength(2)
  })

  it("speaks the idle note when automation is off, once, and never in the execution its own note started", async () => {
    const world = await hooks()
    await world.session.fire("experimental.idle", { sessionID: "ses_1", background: [] })
    expect(world.session.posts).toHaveLength(1)
    expect(world.session.posts[0]!.text).toContain("automatic release is off at this access level")
    expect(world.session.posts[0]!.metadata).toMatchObject({ colab: "idle-check" })

    // The same fingerprint stays silent.
    await world.session.fire("experimental.idle", { sessionID: "ses_1", background: [] })
    expect(world.session.posts).toHaveLength(1)

    // A different session whose newest input is the plugin's own note stays silent too.
    world.session.contextMessages = [{ metadata: { colab: "idle-check" } }]
    await world.session.fire("experimental.idle", { sessionID: "ses_2", background: [] })
    expect(world.session.posts).toHaveLength(1)
  })

  it("survives a host without the experimental hook, and reports it", async () => {
    const clock = new FakeClock(NOW)
    const session = new RecordingHooks()
    session.refuse.add("experimental.idle")
    const registration = await registerHooks({ session: session as never }, { options: await loadOptions({}), ledger: new MemoryLedger(clock), clock })
    expect(registration.problems).toEqual(["idle"])
    expect(session.registered.sort()).toEqual(["compaction", "context"])
  })

  it("never fails the request when the ledger cannot be read", async () => {
    const session = new RecordingHooks()
    const clock = new FakeClock(NOW)
    const broken = {
      listRuntimes: async () => Promise.reject(new Error("disk gone")),
      listRuns: async () => [],
    }
    await registerHooks({ session: session as never }, { options: await loadOptions({}), ledger: broken as never, clock })
    const input = contextInput()
    await expect(session.fire("context", input)).resolves.toBeUndefined()
    expect(input.messages[0]!.content).toHaveLength(1)
  })
})
