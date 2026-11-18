// `colab_status` (design §6, §8.4): accounts, runtimes (ours first), runs, the cost and cleanup blocks, automation and
// the last errors; a provider read that fails is named there instead of failing the tool; only `colab.status` and
// `colab.read` are asserted. And the same Cost row on `/colab-status` and the TUI, from the ledger and the options,
// through the status RPC the TUI reads.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { STOP_WARNING, runStatus } from "../../src/cost/status.js"
import { OPERATIONS } from "../../src/domain/actions.js"
import { CONTRACTS } from "../../src/domain/contract.js"
import { ColabError } from "../../src/domain/errors.js"
import { FileLedger } from "../../src/ledger/store.js"
import { computeStatus } from "../../src/status.js"
import { costText, formatStatus, isStatus, statusRows } from "../../src/rpc.js"
import type { HandlerContext } from "../../src/tools/types.js"
import { handlerContext, runTool } from "../../src/tools/spec.js"
import { CLEAN_CALIBRATION, CPU, FakeClock, fakeDeps, RecordingPermission, T4 } from "../fakes/index.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")

/** The success half of the contract's union, as the handler's callers read it. */
type StatusOk = {
  readonly state: "ok"
  readonly accounts: readonly { readonly alias: string; readonly backend: string; readonly signedIn: boolean; readonly tier?: string }[]
  readonly runtimes: readonly {
    readonly id: string
    readonly ours: boolean
    readonly backend: string
    readonly spec: string
    readonly state: string
    readonly idleSince?: string
    readonly keep?: readonly string[]
    readonly usdPerHour?: number
    readonly idleShutdownMinutes?: number | null
    readonly euc?: boolean
  }[]
  readonly cost: Record<string, unknown>
  readonly automation: string
  readonly cleanup: readonly { readonly saving: string; readonly call: string }[]
  readonly warnings?: readonly string[]
  readonly lastErrors: readonly string[]
}

const statusOf = async (ctx: HandlerContext): Promise<StatusOk> => (await runStatus({}, ctx)) as unknown as StatusOk
const OWN = "oc-01jcoststatus00000000"
const OTHER = "oc-someone-else"
const temporary: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "colab-cost-status-"))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.XDG_STATE_HOME
})

async function world(input: { options?: unknown } = {}) {
  const { deps, fakes } = fakeDeps(input.options === undefined ? {} : { options: input.options })
  fakes.clock.current = NOW
  fakes.auth.grants.set("default", ["https://www.googleapis.com/auth/colaboratory"])
  await deps.ledger.putRuntime({
    id: OWN,
    account: "default",
    backend: "colab",
    spec: T4,
    createdAt: "2026-11-17T10:00:00.000Z",
    nonce: "n1",
    keep: ["/content/outputs/**"],
    lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
    state: "ready",
    calibration: { ...CLEAN_CALIBRATION, baselineConnections: { "kernel-1": 1 } },
  })
  fakes.colab.runtimes.set(OWN, { name: `runtimes/${OWN}`, spec: T4 })
  fakes.colab.runtimes.set(OTHER, { name: `runtimes/${OTHER}`, spec: CPU })
  fakes.runtime.kernels_.set(OWN, [{ id: "kernel-1", name: "python3", executionState: "idle", lastActivity: "2026-11-17T11:20:00.000Z", connections: 2 }])
  fakes.runtime.sessions_.set(OWN, [{ id: "session-1", name: "oc-n1-analysis", path: "/content/a.ipynb", kernelId: "kernel-1" }])
  fakes.vertex.runtimes.set(`projects/p/locations/us-central1/notebookRuntimes/e2`, {
    name: "projects/p/locations/us-central1/notebookRuntimes/e2",
    state: "RUNNING",
    machineType: "e2-standard-4",
    idleShutdownMinutes: null,
    euc: true,
  })
  const permission = new RecordingPermission()
  const account = deps.options.accounts.find((entry) => entry.alias === "default")!
  const ctx = handlerContext({ deps, assert: permission.assert, handler: () => undefined as never }, { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_status", signal: new AbortController().signal }, account)
  return { deps, fakes, permission, ctx }
}

describe("colab_status", () => {
  it("lists the plugin's own runtime first with Jupyter's idle figure, then the ones Google lists for the person", async () => {
    const worldOf = await world()
    const result = await statusOf(worldOf.ctx)
    // The result is what the contract promises, checked against the schema the host validates with.
    expect(CONTRACTS.status.output.safeParse(result).success).toBe(true)
    expect(result.runtimes.map((runtime) => [runtime.id, runtime.ours])).toEqual([
      [OWN, true],
      [OTHER, false],
      ["projects/p/locations/us-central1/notebookRuntimes/e2", false],
    ])
    expect(result.runtimes[0]).toMatchObject({ backend: "colab", spec: "T4 GPU", state: "ready", idleSince: "2026-11-17T11:20:00.000Z", keep: ["/content/outputs/**"] })
    expect(result.runtimes[2]).toMatchObject({ backend: "enterprise", usdPerHour: 0.19, idleShutdownMinutes: null, euc: true })
    expect(result.accounts).toEqual([expect.objectContaining({ alias: "default", backend: "colab", signedIn: true, tier: "SUBSCRIPTION_TIER_PRO" })])
  })

  it("puts the cost block and the cleanup list in the contract's shapes, with the stop warning word for word", async () => {
    const worldOf = await world()
    const result = await statusOf(worldOf.ctx)
    expect(result.cost).toMatchObject({
      consumer: { runtimeHoursToday: 2, running: 1, ratesKnown: false },
      enterprise: { usdPerHour: 0.19, jobsToday: { complete: true } },
    })
    expect(result.automation).toBe("on")
    expect(result.cleanup).toHaveLength(2)
    // Priced savings rank first; each entry is one call and carries what it costs.
    expect(result.cleanup[0]!.call).toContain('"runtime.stop"')
    expect(result.cleanup[0]!.saving).toContain(STOP_WARNING)
    expect(result.cleanup[1]!.call).toBe(`colab_plan({ action: "runtime.delete", params: { runtime: "${OWN}" } })`)
    expect(result.cleanup[1]!.saving).toContain("Files outside keep and memory are lost at release")
    expect(result.warnings).toEqual(expect.arrayContaining(["EUC_RUNTIME", "IDLE_SHUTDOWN_OFF", "RATES_UNKNOWN"]))
  })

  it("asserts colab.status once and colab.read once per provider operation, nothing else", async () => {
    const worldOf = await world()
    // Through the wrapper, as the model and a script reach it: the one colab.status assert comes first.
    const runner = { deps: worldOf.deps, assert: worldOf.permission.assert, handler: () => ({ run: runStatus }) as never }
    const answer = (await runTool("status", {}, { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_status", signal: new AbortController().signal }, runner)) as { state: string }
    expect(answer.state).toBe("ok")
    const actions = worldOf.permission.requests.map((request) => request.action)
    expect(actions[0]).toBe("colab.status")
    expect(new Set(actions)).toEqual(new Set(["colab.status", "colab.read"]))
    const reads = worldOf.permission.requests.filter((request) => request.action === "colab.read").map((request) => request.resources[0])
    expect(reads).toEqual(
      expect.arrayContaining([
        `default:${OPERATIONS.subscriptionGet}`,
        `default:${OPERATIONS.kernelsList}`,
        `default:${OPERATIONS.sessionsList}`,
        `default:${OPERATIONS.runtimesList}`,
        `default:${OPERATIONS.notebookRuntimesList}`,
      ]),
    )
  })

  it("names a failed provider read in lastErrors and answers the rest of the status", async () => {
    const worldOf = await world()
    worldOf.fakes.colab.listRuntimes = async () => Promise.reject(new ColabError("UNAVAILABLE"))
    await worldOf.deps.ledger.putRun({ runId: "run-1", account: "default", backend: "colab", runtime: OWN, startedAt: "2026-11-17T09:00:00.000Z", endedAt: "2026-11-17T09:30:00.000Z", state: "timeout", errorCode: "RUN_TIMEOUT", cellIds: [], outputPaths: [] })
    const result = await statusOf(worldOf.ctx)
    expect(result.state).toBe("ok")
    expect(result.lastErrors).toEqual(expect.arrayContaining(["UNAVAILABLE: runtime list.", "RUN_TIMEOUT: run run-1."]))
    expect(result.lastErrors).toHaveLength(2)
  })

  it("asserts the runtimes.get read when Jupyter cannot answer and Colab's own answer is consulted", async () => {
    const worldOf = await world()
    worldOf.fakes.runtime.kernels = async () => Promise.reject(new ColabError("UNAVAILABLE"))
    await runStatus({}, worldOf.ctx)
    const reads = worldOf.permission.requests.filter((request) => request.action === "colab.read").map((request) => request.resources[0])
    expect(reads).toEqual(expect.arrayContaining([`default:${OPERATIONS.runtimesGet}`]))
  })

  it("never calls a runtime idle, or offers its release, when the ledger's run list cannot be read", async () => {
    const worldOf = await world()
    const original = worldOf.deps.ledger.listRuns.bind(worldOf.deps.ledger)
    worldOf.deps.ledger.listRuns = async (filter) => (filter?.state === "running" ? Promise.reject(new ColabError("LEDGER_UNAVAILABLE")) : original(filter))
    const result = await statusOf(worldOf.ctx)
    expect(result.cleanup.filter((entry) => entry.call.includes("runtime.delete"))).toEqual([])
  })

  it("offers a tainted runtime's release by plan, and never names a creating or tainted runtime as the top cleanup", async () => {
    const worldOf = await world()
    const tainted = `${OWN}x`
    await worldOf.deps.ledger.putRuntime({ id: tainted, account: "default", backend: "colab", spec: T4, createdAt: "2026-11-17T08:00:00.000Z", nonce: "n2", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready", tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: NOW.toISOString() } })
    const result = await statusOf(worldOf.ctx)
    const entry = result.cleanup.find((item) => item.call.includes(tainted))
    expect(entry?.saving).toContain("Tainted")
    expect(entry?.saving).toContain("keep files lost")
    // The idle, untainted runtime stays the planning target of the row, not the tainted one.
    expect(result.cost.attention).toEqual(expect.arrayContaining([expect.stringContaining("tainted")]))
  })

  it("adds BUDGET_WARN when a warn budget is reached, and leaves the figures to the account's option", async () => {
    const worldOf = await world({ options: { accounts: { default: { budget: { enterpriseUsdDaily: 0.1, action: "warn" } } } } })
    await worldOf.deps.ledger.putRun({ runId: "oc-job-1", account: "default", backend: "enterprise", spec: "e2-standard-4", startedAt: "2026-11-17T09:00:00.000Z", endedAt: "2026-11-17T10:00:00.000Z", state: "ok", cellIds: [], outputPaths: [] })
    const result = await statusOf(worldOf.ctx)
    expect(result.warnings).toEqual(expect.arrayContaining(["BUDGET_WARN"]))
  })
})

describe("/colab-status and the TUI, through the status RPC", () => {
  const context = async () => {
    const ctx = {
      agent: { list: async () => ({ data: [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }] }) },
      skill: { list: async () => ({ data: [] }) },
      options: {},
    }
    return { ctx, deps: { access: "all" as const, accounts: [{ alias: "default" as const, backend: "colab" as const }], tools: () => ({ registered: 20 }), hostVersion: "2.3.0", skills: [], problems: () => [] } }
  }

  it("answers a status the TUI accepts, with the Cost and Automation rows, from the ledger and the options", async () => {
    const state = tempDir()
    process.env.XDG_STATE_HOME = state
    const ledger = new FileLedger(join(state, "opencode-colab", "ledger"), { ledgerDays: 90, clock: new FakeClock(NOW) })
    await ledger.putRuntime({ id: OWN, account: "default", backend: "colab", spec: T4, createdAt: "2026-11-17T10:00:00.000Z", nonce: "n1", keep: [], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 }, state: "ready" })
    const { ctx, deps } = await context()
    const status = await computeStatus(ctx as never, deps)
    expect(isStatus(status)).toBe(true)
    expect(status.cost.runtimeHoursToday).toBeGreaterThan(0)
    expect(status.automation).toBe("on")
    expect(statusRows(status).map((row) => row.label)).toEqual(expect.arrayContaining(["Cost", "Automation"]))
    expect(formatStatus(status)).toContain("Cost:")
    expect(formatStatus(status)).toContain("Automation:")
    expect(costText(status.cost)).toContain("runtime-hour")
    expect(costText(status.cost)).toContain("cleanup:")
  })

  it("reports the access level's own automation state", async () => {
    const { ctx } = await context()
    const asking = { ...ctx, options: { access: "ask-changes" } }
    const status = await computeStatus(asking as never, { access: "ask-changes", accounts: [{ alias: "default" as const, backend: "colab" as const }], tools: () => ({ registered: 20 }), hostVersion: "2.3.0", skills: [], problems: () => [] })
    expect(status.automation).toBe("off (access)")
    expect(costText(status.cost)).toContain("0 running")
  })
})
