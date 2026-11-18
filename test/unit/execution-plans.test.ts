// Package D's plan tests (design §7.2, §8.6): runtime.create's preview and commit (eligibility, the accelerator
// allow-list, the runtime cap, the budget, the calibration and its taint-at-birth), runtime.delete's preview and its one
// call to package F's release function, and the re-read that answers PLAN_CHANGED. No Google call.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { T4 } from "../fakes/index.js"
import { ColabError } from "../../src/domain/errors.js"
import { resetLiveRuns } from "../../src/execution/runs.js"
import { alive, gate, iopub, prepared, runtimeRecord, tool } from "../fakes/execution-harness.js"

const dirs: string[] = []
afterEach(async () => {
  resetLiveRuns()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "colab-plans-"))
  dirs.push(dir)
  return dir
}

const spec = T4

describe("runtime.create", () => {
  it("previews the spec, the tier, the allow-list, the lease, keep and the loss sentence, then creates and calibrates", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory, withRuntime: false })
    const planned = await tool(deps, "plan", { action: "runtime.create", params: { spec } }).result
    const plan = planned as { planId: string; category: string; commit: string; preview: Record<string, unknown> }
    expect(plan).toMatchObject({ category: "write", commit: "colab_write" })
    expect(plan.preview).toMatchObject({
      spec: "T4/standard",
      eligible: true,
      tier: "SUBSCRIPTION_TIER_PRO",
      accelerators: ["NONE", "T4", "L4"],
      runtimesOurs: [],
      maxRuntimes: 1,
      reuse: null,
      lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
      keep: ["/content/outputs/**"],
    })
    expect(String(plan.preview.release)).toContain("Files outside keep and all variables in memory are lost")
    const stored = deps.plans.check(plan.planId, { sessionId: "ses_test", agentId: "build", category: "write" })
    const payload = stored.payload as { runtimeId: string; requestId: string; nonce: string }
    expect(payload.runtimeId).toMatch(/^oc-[0-9a-z]{26}$/)
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(payload.nonce).toMatch(/^[0-9a-f]{32}$/)

    const written = await tool(deps, "write", { planId: plan.planId }).result
    const answer = written as { state: string; result: { runtime: string; state: string; calibration?: unknown } }
    expect(answer.state).toBe("ok")
    expect(answer.result).toMatchObject({ runtime: payload.runtimeId, state: "ready" })
    expect(answer.result.calibration).toBeDefined()
    const record = await deps.ledger.getRuntime(payload.runtimeId)
    expect(record).toMatchObject({ state: "ready", nonce: payload.nonce, lease: { releaseAfterIdleMinutes: 20, maxHours: 4 } })
    expect(record?.calibration?.probeKernel.id).toBe("kernel-probe")
    const create = fakes.colab.calls.find((call) => call.method === "createRuntime")
    expect(create?.args[1]).toMatchObject({ runtimeId: payload.runtimeId, requestId: payload.requestId, spec })
  })

  it("refuses an accelerator outside the allow-list, an ineligible spec, and a spent budget", async () => {
    const a100 = { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "A100" } as const
    const first = await prepared({ directory: await workspace(), withRuntime: false })
    expect(await tool(first.deps, "plan", { action: "runtime.create", params: { spec: a100 } }).result).toMatchObject({ state: "refused", error: "ACCELERATOR_NOT_ALLOWED" })
    const second = await prepared({ directory: await workspace(), withRuntime: false })
    second.fakes.colab.specs = second.fakes.colab.specs.map((entry) => ({ ...entry, eligible: false }))
    expect(await tool(second.deps, "plan", { action: "runtime.create", params: { spec } }).result).toMatchObject({ state: "refused", error: "SPEC_NOT_ELIGIBLE" })
    const third = await prepared({ directory: await workspace(), withRuntime: false })
    third.fakes.budget.verdict = "refuse"
    expect(await tool(third.deps, "plan", { action: "runtime.create", params: { spec } }).result).toMatchObject({ state: "refused", error: "BUDGET_REACHED" })
    const fourth = await prepared({ directory: await workspace(), withRuntime: false })
    fourth.fakes.budget.verdict = "warn"
    expect(await tool(fourth.deps, "plan", { action: "runtime.create", params: { spec } }).result).toMatchObject({ state: "ok", warnings: ["BUDGET_WARN"] })
  })

  it("refuses a second runtime over maxRuntimes, naming the one to reuse", async () => {
    const directory = await workspace()
    const { deps, record } = await prepared({ directory })
    const answer = await tool(deps, "plan", { action: "runtime.create", params: { spec } }).result
    expect(answer).toMatchObject({ state: "refused", error: "RUNTIME_CAP" })
    expect((answer as { next: string }).next).toContain(record.id)
  })

  it("answers PLAN_CHANGED when the tier moved between the preview and the commit, and creates nothing", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory, withRuntime: false })
    const plan = (await tool(deps, "plan", { action: "runtime.create", params: { spec } }).result) as { planId: string }
    fakes.colab.tier = "SUBSCRIPTION_TIER_PRO_PLUS"
    expect(await tool(deps, "write", { planId: plan.planId }).result).toMatchObject({ state: "refused", error: "PLAN_CHANGED" })
    expect(fakes.colab.calls.some((call) => call.method === "createRuntime")).toBe(false)
  })

  it("records a runtime whose first check found a credential as tainted at birth", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory, withRuntime: false })
    fakes.check.calibrate = async () => {
      throw new ColabError("RUNTIME_HAS_CREDENTIALS")
    }
    const plan = (await tool(deps, "plan", { action: "runtime.create", params: { spec } }).result) as { planId: string }
    const payload = deps.plans.check(plan.planId, { sessionId: "ses_test", agentId: "build", category: "write" }).payload as { runtimeId: string }
    const answer = await tool(deps, "write", { planId: plan.planId }).result
    expect(answer).toMatchObject({ state: "ok", result: { state: "tainted", error: "RUNTIME_HAS_CREDENTIALS" } })
    expect((await deps.ledger.getRuntime(payload.runtimeId))?.tainted?.code).toBe("RUNTIME_HAS_CREDENTIALS")
  })

  it("records a create the LRO has not finished as creating, for a retry with the same requestId to join", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory, withRuntime: false })
    Object.assign(fakes.colab, { createRuntime: async () => ({ done: false, operation: "operations/op-1" }) })
    const plan = (await tool(deps, "plan", { action: "runtime.create", params: { spec } }).result) as { planId: string }
    const payload = deps.plans.check(plan.planId, { sessionId: "ses_test", agentId: "build", category: "write" }).payload as { runtimeId: string; requestId: string }
    const answer = await tool(deps, "write", { planId: plan.planId }).result
    expect(answer).toMatchObject({ state: "ok", result: { state: "creating", operation: "operations/op-1" } })
    expect(await deps.ledger.getRuntime(payload.runtimeId)).toMatchObject({ state: "creating", nonce: expect.any(String) })
    expect(payload.requestId).toBeTruthy()
  })

  it("refuses runtime.create on an Enterprise account through the plan route", async () => {
    const directory = await workspace()
    const { deps } = await prepared({ directory, options: { accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1", outputBucket: "gs://b" } } } })
    const answer = await tool(deps, "plan", { account: "work", action: "runtime.create", params: { spec } }).result
    expect(answer).toMatchObject({ state: "refused", error: "ACTION_UNSUPPORTED" })
    expect((answer as { next: string }).next).toContain("job.create")
  })
})

describe("runtime.delete", () => {
  it("previews the age, the idle state, the files outside keep and the loss, then calls F's release", async () => {
    const directory = await workspace()
    const { deps, fakes, record, runtime } = await prepared({ directory })
    runtime.contents.set(record.id, new Map([
      ["/content/outputs/kept.csv", Buffer.from("x")],
      ["/content/scratch.bin", Buffer.from("y")],
    ]))
    runtime.kernels_.set(record.id, [{ id: "k1", name: "python3", executionState: "idle", lastActivity: "2026-11-17T08:50:00.000Z", connections: 0 }])
    const plan = (await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result) as { planId: string; category: string; preview: Record<string, unknown> }
    expect(plan.category).toBe("delete")
    expect(plan.preview).toMatchObject({ runtime: record.id, spec: "T4/standard", idle: true, kernels: 1, activeRun: false, force: false, filesOutsideKeep: ["/content/scratch.bin"] })
    expect(String(plan.preview.memory)).toContain("Variables in memory are lost")
    const answer = await tool(deps, "delete", { planId: plan.planId }).result
    expect(answer).toMatchObject({ state: "ok", result: { runtime: record.id, state: "released" } })
    expect(fakes.release.released).toEqual([{ id: record.id, reason: "plan", force: false }])
  })

  it("refuses a run that is active on the runtime unless the plan forces it", async () => {
    const directory = await workspace()
    const { deps, record, runtime } = await prepared({ directory })
    runtime.gate = gate()
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
    const running = (await tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 0 }).result) as { runId: string }
    expect(await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result).toMatchObject({ state: "refused", error: "RUNTIME_BUSY" })
    const forced = await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id, force: true } }).result
    expect(forced).toMatchObject({ state: "ok" })
    runtime.gate.open()
    const { liveRun } = await import("../../src/execution/runs.js")
    await liveRun(running.runId)?.done
  })

  it("answers PLAN_CHANGED when a file outside keep appeared after the preview", async () => {
    const directory = await workspace()
    const { deps, record, runtime } = await prepared({ directory })
    const plan = (await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result) as { planId: string }
    const files = runtime.contents.get(record.id) ?? new Map<string, Uint8Array>()
    files.set("/content/late.bin", Buffer.from("z"))
    runtime.contents.set(record.id, files)
    expect(await tool(deps, "delete", { planId: plan.planId }).result).toMatchObject({ state: "refused", error: "PLAN_CHANGED" })
  })

  it("releases a tainted runtime by plan", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory, record: runtimeRecord({ tainted: { code: "RUNTIME_SHARED", at: "2026-11-17T09:00:00.000Z" } }) })
    const record = (await tool(deps, "runtimes", {}).result as { runtimes: { id: string }[] }).runtimes[0]!
    const plan = await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result
    expect(plan).toMatchObject({ state: "ok" })
    const answer = await tool(deps, "delete", { planId: (plan as { planId: string }).planId }).result
    expect(answer).toMatchObject({ state: "ok", result: { state: "released" } })
    expect(fakes.release.released[0]!.id).toBe(record.id)
  })

  it("refuses a runtime that is not the plugin's own", async () => {
    const directory = await workspace()
    const { deps } = await prepared({ directory })
    expect(await tool(deps, "plan", { action: "runtime.delete", params: { runtime: "oc-nope" } }).result).toMatchObject({ state: "refused", error: "RUNTIME_NOT_OURS" })
  })
})

describe("the plan handlers D owns", () => {
  it("are exactly runtime.create and the consumer runtime.delete", async () => {
    const handlers = (await import("../../src/execution/index.js")).PLAN_HANDLERS
    expect(Object.keys(handlers).sort()).toEqual(["runtime.create", "runtime.delete"])
    expect(Object.keys(handlers["runtime.delete"]!)).toEqual(["colab"])
  })
})
