// The plan store and the colab_plan → colab_write / colab_delete routing (design §7.2), with a test plan handler
// standing in for a package's.
import { describe, expect, it } from "vitest"
import { PLAN_ACTIONS } from "../../src/domain/actions.js"
import { PlanStore } from "../../src/domain/plans.js"
import { commitTool, planHandler, planTool } from "../../src/plans/route.js"
import { handlerContext, runTool, type Runner } from "../../src/tools/spec.js"
import type { PlanHandlers } from "../../src/tools/types.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"

const call = (session = "ses_a", agent = "build") => ({ sessionID: session, agent, messageID: "msg", id: "call", signal: new AbortController().signal })
const CPU = { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" }

function setup(handlers: PlanHandlers, options?: unknown) {
  const { deps, fakes } = fakeDeps({ options })
  const permission = new RecordingPermission()
  let runner: Runner
  const tools = { plan: planTool(handlers), write: commitTool("write", handlers, () => runner), delete: commitTool("delete", handlers, () => runner) }
  runner = { deps, assert: permission.assert, handler: (name) => (tools as never)[name] }
  return { deps, fakes, permission, runner }
}

describe("the plan store", () => {
  const base = { action: "runtime.create" as const, category: "write" as const, account: "default", backend: "colab" as const, operation: "colaboratory.runtimes.create" as const, sessionId: "s", agentId: "a", preview: {}, payload: {}, fingerprint: {} }

  it("binds a plan to its session, agent and category, and uses it once", () => {
    const store = new PlanStore(300)
    const plan = store.create(base)
    expect(plan.id).toMatch(/^plan_[\w-]{24}$/)
    expect(() => store.check(plan.id, { sessionId: "other", agentId: "a", category: "write" })).toThrow(/^PLAN_CALLER_MISMATCH: /)
    expect(() => store.check(plan.id, { sessionId: "s", agentId: "other", category: "write" })).toThrow(/^PLAN_CALLER_MISMATCH: /)
    expect(() => store.check(plan.id, { sessionId: "s", agentId: "a", category: "delete" })).toThrow(/^CATEGORY_MISMATCH: .*colab_write/)
    store.acquire(plan.id, { sessionId: "s", agentId: "a", category: "write" })
    expect(() => store.acquire(plan.id, { sessionId: "s", agentId: "a", category: "write" })).toThrow(/^PLAN_ALREADY_USED: /)
    store.complete(plan.id)
    expect(() => store.check(plan.id, { sessionId: "s", agentId: "a", category: "write" })).toThrow(/^PLAN_ALREADY_USED: /)
    expect(() => store.check("plan_missing", { sessionId: "s", agentId: "a", category: "write" })).toThrow(/^PLAN_NOT_FOUND: /)
  })

  it("expires after its TTL, and a failed commit spends the plan", () => {
    let now = 0
    const store = new PlanStore(300, () => now)
    const plan = store.create(base)
    now = 300_000
    expect(() => store.check(plan.id, { sessionId: "s", agentId: "a", category: "write" })).toThrow(/^PLAN_EXPIRED: /)
    now = 0
    const second = new PlanStore(300, () => now).create(base)
    const failing = new PlanStore(300, () => now)
    const third = failing.create(base)
    failing.acquire(third.id, { sessionId: "s", agentId: "a", category: "write" })
    failing.release(third.id)
    expect(() => failing.check(third.id, { sessionId: "s", agentId: "a", category: "write" })).toThrow(/^PLAN_EXPIRED: /)
    expect(second.state).toBe("ready")
  })
})

describe("the routing", () => {
  const handlers: PlanHandlers = {
    "runtime.create": {
      colab: {
        preview: async (params) => ({ preview: { spec: params.spec.accelerator }, payload: { spec: params.spec }, fingerprint: { eligible: true } }),
        commit: async (plan) => ({ created: (plan.payload.spec as { accelerator: string }).accelerator }),
      },
    },
    "runtime.delete": { colab: { preview: async (params) => ({ preview: { runtime: params.runtime }, payload: {}, fingerprint: {} }), commit: async () => ({ released: true }) } },
  }

  it("previews, stores and commits a write plan with one ask on the plan's resource", async () => {
    const { runner, permission } = setup(handlers)
    const planned = (await runTool("plan", { action: "runtime.create", params: { spec: CPU } }, call(), runner)) as { planId: string; commit: string; category: string }
    expect(planned).toMatchObject({ state: "ok", action: "runtime.create", category: "write", commit: "colab_write", preview: { spec: "NONE" } })
    const committed = await runTool("write", { planId: planned.planId }, call(), runner)
    expect(committed).toEqual({ state: "ok", planId: planned.planId, action: "runtime.create", result: { created: "NONE" } })
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.plan", ["default"]],
      ["colab.write", ["default:colaboratory.runtimes.create"]],
    ])
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ error: "PLAN_ALREADY_USED" })
  })

  it("refuses a commit from another session, the wrong commit tool, and keeps the plan when the ask is declined", async () => {
    const { runner, permission } = setup(handlers)
    const planned = (await runTool("plan", { action: "runtime.delete", params: { runtime: "oc-01" } }, call(), runner)) as { planId: string }
    expect(await runTool("delete", { planId: planned.planId }, call("ses_b"), runner)).toMatchObject({ error: "PLAN_CALLER_MISMATCH" })
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ error: "CATEGORY_MISMATCH", next: "Commit it with colab_delete, passing only {planId}." })
    permission.denyAll()
    await expect(runTool("delete", { planId: planned.planId }, call(), runner)).rejects.toThrow(/denied/)
    permission.decide = () => undefined
    expect(await runTool("delete", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "ok", result: { released: true } })
  })

  it("answers refused, unknown and other-backend actions with their own codes, and bad params as INPUT_INVALID", async () => {
    const { runner } = setup(handlers, { accounts: { work: { backend: "enterprise", project: "p", region: "us-central1" }, default: {} } })
    expect(await runTool("plan", { action: "share", params: {} }, call(), runner)).toMatchObject({ error: "SHARE_UNSUPPORTED" })
    expect(await runTool("plan", { action: "template.create" }, call(), runner)).toMatchObject({ error: "ACTION_UNSUPPORTED" })
    expect(await runTool("plan", { action: "teleport" }, call(), runner)).toMatchObject({ error: "ACTION_UNSUPPORTED" })
    expect(await runTool("plan", { action: "runtime.create", account: "work", params: { spec: CPU } }, call(), runner)).toMatchObject({ error: "ACTION_UNSUPPORTED", next: expect.stringContaining("job.create") })
    expect(await runTool("plan", { action: "runtime.create", params: { spec: { variant: "VARIANT_QPU" } } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path: "a.ipynb" } } }, call(), runner)).toMatchObject({ error: "NOT_IMPLEMENTED" })
  })

  it("knows a category for every action, and a handler only where the action exists on that backend", () => {
    for (const [action, entry] of Object.entries(PLAN_ACTIONS)) {
      expect(["write", "delete"]).toContain(entry.category)
      for (const backend of ["colab", "enterprise"] as const) {
        if ((entry.backends as Record<string, unknown>)[backend]) continue
        expect(() => planHandler(handlers, action, backend), `${action} on ${backend}`).toThrow(/^ACTION_UNSUPPORTED: /)
      }
    }
  })

  it("gives a commit's handler the plan's account, not the caller's", async () => {
    const seen: string[] = []
    const local: PlanHandlers = { "drive.trash": { enterprise: { preview: async () => ({ preview: {}, payload: {}, fingerprint: {} }), commit: async (_plan, ctx) => (seen.push(ctx.account.alias), {}) } } }
    const { runner } = setup(local, { accounts: { work: { backend: "enterprise" }, default: {} } })
    const planned = (await runTool("plan", { action: "drive.trash", account: "work", params: { drive: "file-1" } }, call(), runner)) as { planId: string }
    await runTool("delete", { planId: planned.planId }, call(), runner)
    expect(seen).toEqual(["work"])
    expect(handlerContext).toBeTypeOf("function")
  })
})
