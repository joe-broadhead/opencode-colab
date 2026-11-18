// The automation (design §8.3, §15.1): the consent matrix, the single owner lock, and one sweep over the Jupyter idle
// rule — each blocker (busy kernel, recent activity, foreign session, extra connection, active run, tainted) leaves a
// runtime alone, and an idle one is released through the one release function.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  automationNote,
  automationOwner,
  automationRuns,
  automationState,
  createAutomationLock,
  createAutomationLoop,
  runAutomationOnce,
} from "../../src/cost/automation.js"
import { ColabError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import type { KernelInfo, Release, RunRecord, RuntimeRecord, SessionInfo } from "../../src/ports.js"
import { CLEAN_CALIBRATION, FakeClock, FakeColabApi, FakeRelease, FakeRuntimeProtocol, MemoryLedger, T4 } from "../fakes/index.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const ID = "oc-01jcostautomation00000"
const temporary: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "colab-cost-automation-"))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const record = (overrides: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
  id: ID,
  account: "default",
  backend: "colab",
  spec: T4,
  createdAt: "2026-11-17T10:00:00.000Z",
  nonce: "n1",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  calibration: { ...CLEAN_CALIBRATION, baselineConnections: { "kernel-1": 1 } },
  ...overrides,
})

const kernel = (overrides: Partial<KernelInfo> = {}): KernelInfo => ({ id: "kernel-1", name: "python3", executionState: "idle", lastActivity: "2026-11-17T11:20:00.000Z", connections: 2, ...overrides })
const session = (): SessionInfo => ({ id: "session-1", name: "oc-n1-analysis", path: "/content/a.ipynb", kernelId: "kernel-1" })

function world(input: { kernels?: readonly KernelInfo[]; sessions?: readonly SessionInfo[]; runtimes?: readonly RuntimeRecord[]; runs?: RunRecord["state"][] } = {}) {
  const clock = new FakeClock(NOW)
  const ledger = new MemoryLedger(clock)
  const runtime = new FakeRuntimeProtocol()
  runtime.kernels_.set(ID, [...(input.kernels ?? [kernel()])])
  runtime.sessions_.set(ID, [...(input.sessions ?? [session()])])
  const colab = new FakeColabApi()
  colab.runtimes.set(ID, { name: `runtimes/${ID}`, spec: T4 })
  const release = new FakeRelease()
  const add = async () => {
    for (const item of input.runtimes ?? [record()]) await ledger.putRuntime(item)
    for (const [index, state] of (input.runs ?? []).entries()) {
      await ledger.putRun({ runId: `run-${index}`, account: "default", backend: "colab", runtime: ID, startedAt: NOW.toISOString(), state, cellIds: [], outputPaths: [] })
    }
  }
  return { clock, ledger, runtime, colab, release, add }
}

describe("consent: which automation state applies (design §8.3 step 4)", () => {
  it("is on at access all with the default auto, off (access) at the other levels, on (consent) only for the option", () => {
    expect(automationState({ automation: "auto", access: "all", owner: true })).toBe("on")
    expect(automationState({ automation: "auto", access: "all", owner: false })).toBe("not-owner")
    expect(automationState({ automation: "auto", access: "ask-changes", owner: true })).toBe("off (access)")
    expect(automationState({ automation: "auto", access: "read-only", owner: true })).toBe("off (access)")
    expect(automationState({ automation: "on", access: "ask-changes", owner: true })).toBe("on (consent)")
    expect(automationState({ automation: "on", access: "read-only", owner: true })).toBe("on (consent)")
    expect(automationState({ automation: "on", access: "all", owner: false })).toBe("not-owner")
    expect(automationState({ automation: "off", access: "all", owner: true })).toBe("off")
    expect(automationState({ automation: "off", access: "all", owner: false })).toBe("off")
  })

  it("runs only in the two on states, and every state has one sentence", () => {
    expect(["on", "on (consent)"].every((state) => automationRuns(state as never))).toBe(true)
    expect(["off", "off (access)", "not-owner"].some((state) => automationRuns(state as never))).toBe(false)
    for (const state of ["on", "on (consent)", "off", "off (access)", "not-owner"] as const) {
      expect(automationNote(state)).toMatch(/runtime/)
    }
  })
})

describe("one automation owner per machine", () => {
  it("gives the lock to one process, keeps a heartbeat, and hands it on only when released or stale", () => {
    const dir = tempDir()
    let clock = 1_000_000
    const now = () => clock
    // Two pids the test's process table knows, so liveness is deterministic.
    const alive = (pid: number) => pid === 4242 || pid === 4343
    const first = createAutomationLock(dir, { pid: 4242, now, alive })
    const second = createAutomationLock(dir, { pid: 4343, now, alive })
    expect(first.claim()).toBe(true)
    expect(second.claim()).toBe(false)

    // The heartbeat keeps it fresh: after 100 s the owner still holds it; after 130 s without one it is stale.
    first.heartbeat()
    clock += 100_000
    expect(second.claim()).toBe(false)
    clock += 30_000
    expect(first.heartbeat(), "the owner sees a fresh state").toBeUndefined()
    const third = createAutomationLock(dir, { pid: 4343, now: () => clock })
    expect(third.claim()).toBe(true)
    third.release()

    first.release()
    expect(second.claim()).toBe(true)
    second.release()
  })

  it("reads who owns the automation without claiming it, for status", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "automation", "lock"), { recursive: true })
    writeFileSync(join(dir, "automation", "lock", "state.json"), JSON.stringify({ pid: 1, at: 1_000_000 }))
    expect(automationOwner(dir, () => 1_000_000, 4343)).toEqual({ owner: false, holder: 1 })
    expect(automationOwner(dir, () => 1_000_000 + 121_000, 4343)).toEqual({ owner: true })
    expect(automationOwner(tempDir(), () => 1_000_000, 4343)).toEqual({ owner: true })
  })

  it("breaks a lock whose process is gone", () => {
    const dir = tempDir()
    mkdirSync(join(dir, "automation", "lock"), { recursive: true })
    writeFileSync(join(dir, "automation", "lock", "state.json"), JSON.stringify({ pid: 2147483646, at: Date.now() }))
    const lock = createAutomationLock(dir)
    expect(lock.claim()).toBe(true)
    lock.release()
  })

  it("a process at another access level never takes the lock, so the process the person consented through keeps it", async () => {
    const dir = tempDir()
    const safe = await loadOptions({})
    const ledger = new MemoryLedger()
    const clock = new FakeClock(NOW)
    const first = createAutomationLoop({ options: safe, ledger, runtime: new FakeRuntimeProtocol(), colab: new FakeColabApi(), release: new FakeRelease(), clock, lockDir: dir })
    expect(first.state()).toBe("on")
    const asking = createAutomationLoop({
      options: await loadOptions({ access: "ask-changes" }),
      ledger,
      runtime: new FakeRuntimeProtocol(),
      colab: new FakeColabApi(),
      release: new FakeRelease(),
      clock,
      lockDir: dir,
    })
    expect(asking.state()).toBe("off (access)")
    expect(first.state()).toBe("on")
    // Another process (pid 1 is alive) takes the lock, as B's lease design allows after a restart.
    writeFileSync(join(dir, "automation", "lock", "state.json"), JSON.stringify({ pid: 1, at: Date.now() }))
    expect(first.state()).toBe("not-owner")
    expect(asking.state()).toBe("off (access)")
    // A stale heartbeat hands the lock back.
    writeFileSync(join(dir, "automation", "lock", "state.json"), JSON.stringify({ pid: 1, at: Date.now() - 3 * 60_000 }))
    expect(first.state()).toBe("on")
    await first.dispose()
    await asking.dispose()
  })

  it("the option automation: on is the person's standing yes at any access level", async () => {
    const loop = createAutomationLoop({
      options: await loadOptions({ access: "read-only", automation: "on" }),
      ledger: new MemoryLedger(),
      runtime: new FakeRuntimeProtocol(),
      colab: new FakeColabApi(),
      release: new FakeRelease(),
      clock: new FakeClock(NOW),
      lockDir: tempDir(),
    })
    expect(loop.state()).toBe("on (consent)")
    await loop.dispose()
  })
})

describe("one sweep", () => {
  const sweep = async (worldOf: ReturnType<typeof world>, options: unknown = {}) => {
    await worldOf.add()
    return runAutomationOnce({
      options: await loadOptions(options),
      ledger: worldOf.ledger,
      runtime: worldOf.runtime,
      colab: worldOf.colab,
      release: worldOf.release,
      now: NOW,
      signal: new AbortController().signal,
    })
  }

  it("releases an idle runtime through the one release function, with the reason Jupyter's activity gives", async () => {
    const worldOf = world()
    const outcome = await sweep(worldOf)
    expect(outcome.released).toEqual([{ id: ID, reason: "idle", harvested: 1 }])
    expect(worldOf.release.released).toEqual([{ id: ID, reason: "idle", force: false }])
    expect(outcome.attention).toEqual([])
  })

  it("leaves alone a busy kernel, recent activity, a foreign session, an extra connection and an active run", async () => {
    for (const input of [
      { kernels: [kernel({ executionState: "busy" })] },
      { kernels: [kernel({ lastActivity: "2026-11-17T11:55:00.000Z" })] },
      { sessions: [session(), { id: "s2", name: "someone-else", path: "/content/b.ipynb", kernelId: "kernel-1" }] },
      { kernels: [kernel({ connections: 3 })] },
      { runs: ["running" as const] },
    ]) {
      const worldOf = world(input)
      const outcome = await sweep(worldOf)
      expect(outcome.released).toEqual([])
      expect(worldOf.release.released).toEqual([])
    }
  })

  it("never touches a tainted runtime, and lists it as released only by plan", async () => {
    const worldOf = world({ runtimes: [record({ tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: NOW.toISOString() } })] })
    const outcome = await sweep(worldOf)
    expect(outcome.released).toEqual([])
    expect(worldOf.release.released).toEqual([])
    expect(outcome.attention.join(" ")).toMatch(/tainted/)
  })

  it("closes a runtime that Colab no longer has, and names the one it could not read", async () => {
    const gone = world()
    gone.runtime.kernels_ = new Map()
    gone.runtime.kernels = async () => Promise.reject(new ColabError("RUNTIME_NOT_OURS"))
    gone.colab.runtimes.delete(ID)
    const closed = await sweep(gone)
    expect(closed.released).toEqual([])
    expect(closed.attention.join(" ")).toMatch(/ended/)
    expect(await gone.ledger.getRuntime(ID)).toMatchObject({ state: "gone" })

    const unreadable = world()
    unreadable.runtime.kernels = async () => Promise.reject(new ColabError("UNAVAILABLE"))
    const left = await sweep(unreadable)
    expect(left.released).toEqual([])
    expect(left.attention.join(" ")).toMatch(/could not be read/)
    expect(await unreadable.ledger.getRuntime(ID)).toMatchObject({ state: "ready" })
  })

  it("reports a harvest that blocked the release, and releases nothing", async () => {
    const worldOf = world()
    const blocked: Release = { release: async () => ({ harvested: [], released: false, warnings: ["UNHARVESTED"] }) }
    await worldOf.add()
    const outcome = await runAutomationOnce({
      options: await loadOptions({}),
      ledger: worldOf.ledger,
      runtime: worldOf.runtime,
      colab: worldOf.colab,
      release: blocked,
      now: NOW,
      signal: new AbortController().signal,
    })
    expect(outcome.released).toEqual([])
    expect(outcome.attention.join(" ")).toMatch(/keep paths could not be harvested/)
  })

  it("is idle by lifetime when the lease's hours passed and Jupyter's activity is recent", async () => {
    const worldOf = world({ runtimes: [record({ createdAt: "2026-11-17T05:00:00.000Z" })], kernels: [kernel({ lastActivity: "2026-11-17T11:55:00.000Z" })] })
    const outcome = await sweep(worldOf)
    expect(outcome.released).toEqual([{ id: ID, reason: "lifetime", harvested: 1 }])
  })

  it("works the same for a runtime whose lease names its own thresholds", async () => {
    const worldOf = world({ runtimes: [record({ lease: { releaseAfterIdleMinutes: 60, maxHours: 8 } })] })
    const outcome = await sweep(worldOf)
    // 40 minutes idle is under the record's 60-minute threshold.
    expect(outcome.released).toEqual([])
  })
})
