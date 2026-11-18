// The Jupyter idle rule (design §8.3 step 1, §15.1 automation): idle comes from Jupyter, and every one of busy,
// recent activity, a foreign session, an extra connection and an active run blocks the release; a runtime older than
// `maxRuntimeHours` with the same conditions is idle by `lifetime`. Shapes: Jupyter Server's REST API, design §18 [19].
import { describe, expect, it } from "vitest"
import { idleRuleOf, idleVerdict, readIdle, type IdleRule } from "../../src/cost/idle.js"
import { ColabError } from "../../src/domain/errors.js"
import type { KernelInfo, RuntimeRecord, SessionInfo } from "../../src/ports.js"
import { CLEAN_CALIBRATION } from "../fakes/index.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const RULE: IdleRule = { autoReleaseMinutes: 20, maxHours: 4 }

const record = (overrides: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
  id: "oc-01jcostidle",
  account: "default",
  backend: "colab",
  spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" },
  createdAt: "2026-11-17T10:00:00.000Z",
  nonce: "n1",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  calibration: { ...CLEAN_CALIBRATION, baselineConnections: { "kernel-1": 1 } },
  ...overrides,
})

const kernel = (overrides: Partial<KernelInfo> = {}): KernelInfo => ({
  id: "kernel-1",
  name: "python3",
  executionState: "idle",
  lastActivity: "2026-11-17T11:20:00.000Z",
  connections: 2,
  ...overrides,
})

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({ id: "session-1", name: "oc-n1-analysis", path: "/content/analysis.ipynb", kernelId: "kernel-1", ...overrides })

const verdict = (input: { kernels?: readonly KernelInfo[]; sessions?: readonly SessionInfo[]; activeRuns?: number; record?: RuntimeRecord } = {}) =>
  idleVerdict({ record: input.record ?? record(), kernels: input.kernels ?? [kernel()], sessions: input.sessions ?? [session()], activeRuns: input.activeRuns ?? 0, rule: RULE, now: NOW })

describe("the Jupyter idle rule", () => {
  it("is idle when every kernel is idle, only our session is open, the baseline plus our connection is all, and Jupyter's activity passed the threshold", () => {
    const answer = verdict()
    expect(answer).toMatchObject({ state: "idle", reason: "idle", lastActivity: "2026-11-17T11:20:00.000Z" })
    if (answer.state === "idle") expect(Math.round(answer.idleMinutes)).toBe(40)
  })

  it("blocks a busy kernel, a starting one, and a state it does not know", () => {
    expect(verdict({ kernels: [kernel({ executionState: "busy" })] })).toEqual({ state: "blocked", why: "kernel-not-idle" })
    expect(verdict({ kernels: [kernel({ executionState: "starting" })] })).toEqual({ state: "blocked", why: "kernel-not-idle" })
    expect(verdict({ kernels: [kernel({ executionState: "reconnecting" })] })).toEqual({ state: "blocked", why: "kernel-not-idle" })
    expect(verdict({ kernels: [kernel({ executionState: "dead" })] })).toEqual({ state: "blocked", why: "kernel-not-idle" })
  })

  it("blocks activity more recent than autoReleaseMinutes", () => {
    expect(verdict({ kernels: [kernel({ lastActivity: "2026-11-17T11:50:00.000Z" })] })).toEqual({ state: "blocked", why: "recent-activity" })
  })

  it("blocks a session whose name lacks the runtime's nonce, even one named oc-", () => {
    expect(verdict({ sessions: [session(), session({ id: "session-2", name: "oc-someone-elses" })] })).toEqual({ state: "blocked", why: "foreign-session" })
    expect(verdict({ sessions: [session(), session({ id: "session-2", name: "analysis" })] })).toEqual({ state: "blocked", why: "foreign-session" })
  })

  it("blocks a connection beyond the calibrated baseline plus one per session of ours", () => {
    // baseline 1 + our one session = 2; three is another client.
    expect(verdict({ kernels: [kernel({ connections: 3 })] })).toEqual({ state: "blocked", why: "extra-connection" })
    // A proxy's own connection is in the baseline and is not another client (design §7.4 step 2).
    expect(verdict({ kernels: [kernel({ connections: 2 })] })).toMatchObject({ state: "idle" })
  })

  it("blocks a runtime with a run of ours active", () => {
    expect(verdict({ activeRuns: 1 })).toEqual({ state: "blocked", why: "active-run" })
  })

  it("never calls a tainted runtime, or one that is not ready, idle", () => {
    expect(verdict({ record: record({ tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: NOW.toISOString() } }) })).toEqual({ state: "blocked", why: "tainted" })
    expect(verdict({ record: record({ state: "creating" }) })).toEqual({ state: "blocked", why: "not-ready" })
    expect(verdict({ record: record({ state: "released" }) })).toEqual({ state: "blocked", why: "not-ready" })
  })

  it("is idle by lifetime when Jupyter's activity is recent but the runtime is older than maxRuntimeHours and everything else is idle", () => {
    const answer = verdict({ record: record({ createdAt: "2026-11-17T05:00:00.000Z" }), kernels: [kernel({ lastActivity: "2026-11-17T11:55:00.000Z" })] })
    expect(answer).toMatchObject({ state: "idle", reason: "lifetime" })
    if (answer.state === "idle") expect(Math.round(answer.ageHours)).toBe(7)
  })

  it("uses the runtime's own age as the activity when Jupyter reports no kernel yet", () => {
    expect(verdict({ kernels: [], sessions: [] })).toMatchObject({ state: "idle", reason: "idle" })
    expect(verdict({ kernels: [], sessions: [], record: record({ createdAt: "2026-11-17T11:55:00.000Z" }) })).toEqual({ state: "blocked", why: "recent-activity" })
  })

  it("takes the per-runtime lease when the record has one", () => {
    expect(idleRuleOf({ createdAt: record().createdAt, lease: { releaseAfterIdleMinutes: 45, maxHours: 8 } }, RULE)).toEqual({ autoReleaseMinutes: 45, maxHours: 8 })
    expect(idleRuleOf({ createdAt: record().createdAt, lease: { releaseAfterIdleMinutes: 20, maxHours: 4 } }, { autoReleaseMinutes: 5, maxHours: 1 })).toEqual({ autoReleaseMinutes: 20, maxHours: 4 })
  })
})

describe("readIdle: a runtime the plugin cannot read", () => {
  const base = {
    record: record(),
    activeRuns: 0,
    rule: RULE,
    now: NOW,
    sessions: async () => [session()],
    get: async () => ({ name: "runtimes/oc-01jcostidle" }),
  }

  it("passes Jupyter's answer through when the read works", async () => {
    expect(await readIdle({ ...base, kernels: async () => [kernel()] })).toMatchObject({ state: "idle" })
  })

  it("closes a runtime only when Colab agrees it is gone: a fence refusal is gone only with no runtime behind it", async () => {
    // B's fence refuses a `creating` record as not-ours; Colab still has it, so it is not gone (review M1).
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("RUNTIME_NOT_OURS")) })).toEqual({ state: "blocked", why: "unreadable", code: "RUNTIME_NOT_OURS" })
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("RUNTIME_NOT_OURS")), get: async () => undefined })).toMatchObject({ state: "gone" })
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("UNAVAILABLE")), get: async () => undefined })).toMatchObject({ state: "gone" })
    // A released ledger record is closed; nothing to track.
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("RUNTIME_GONE")) })).toMatchObject({ state: "gone" })
  })

  it("leaves alone, with a code, a runtime whose state it cannot read", async () => {
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("UNAVAILABLE")) })).toEqual({ state: "blocked", why: "unreadable", code: "UNAVAILABLE" })
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("RUNTIME_SHARED")) })).toEqual({ state: "blocked", why: "tainted", code: "RUNTIME_SHARED" })
    // Another process's lease is a refusal, not a verdict: the runtime is left alone.
    expect(await readIdle({ ...base, kernels: async () => Promise.reject(new ColabError("RUNTIME_BUSY")) })).toEqual({ state: "blocked", why: "unreadable", code: "RUNTIME_BUSY" })
  })
})
