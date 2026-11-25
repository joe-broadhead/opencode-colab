import { describe, expect, test } from "vitest"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { deleteHandler, planDeleteHandler, planWriteHandler, writeHandler } from "../../src/handlers/plan.js"
import type { RuntimeRecord } from "../../src/provider/ports.js"
import { fakeDeps } from "../fakes/index.js"

const CPU = { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } as const

const runtime = (): RuntimeRecord => ({
  id: "oc-work",
  account: "work",
  backend: "colab",
  spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" },
  createdAt: "2026-11-21T08:00:00.000Z",
  nonce: "0123456789abcdef0123456789abcdef",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  calibration: { hiddenPathsVisible: false, baselineConnections: {}, probeKernel: { id: "k", executionCount: 1, startMs: 1, rttMs: 1 }, snippetVersion: "fake", at: "2026-11-21T08:00:10.000Z" },
})

function call(account: string, plan?: unknown): { call: MethodCall; events: unknown[] } {
  const events: unknown[] = []
  return {
    events,
    call: {
      sessionID: "ses_plan",
      agent: "build",
      messageID: "msg_plan",
      id: "call_plan",
      signal: new AbortController().signal,
      progress: async () => undefined,
      account,
      ...(plan === undefined ? {} : { plan }),
      bus: { emit: async (name: string, data: unknown) => void events.push({ name, data }) },
      access: { rules: [] },
      unguardedAgents: async () => [],
      door: "rpc",
    } as unknown as MethodCall,
  }
}

describe("plan and commit", () => {
  test("plan_write previews, names the commit method, and writes nothing", async () => {
    const { deps, fakes } = fakeDeps({ options: { access: "all", accounts: { work: { access: "write" } } } })
    const handler = planWriteHandler(deps)
    const answer = (await handler.run({ action: "runtime.create", params: { spec: CPU } }, call("work").call)) as Record<string, unknown>
    expect(answer.method).toBe("write")
    expect(answer).not.toHaveProperty("planId")
    expect(answer.trust).toBe("untrusted")
    expect(Array.isArray(answer.changes)).toBe(true)
    expect(answer.output).toMatchObject({ eligible: true, accelerator: "NONE" })
    expect(fakes.colab.calls.some((entry) => entry.method === "createRuntime")).toBe(false)
    expect(fakes.ledger.runtimes.size).toBe(0)
  })

  test("write commits the plan, creates the runtime and emits changed", async () => {
    const { deps, fakes } = fakeDeps({ options: { access: "all", accounts: { work: { access: "write" } } } })
    const plan = (await planWriteHandler(deps).run({ action: "runtime.create", params: { spec: CPU } }, call("work").call)) as Record<string, unknown>
    const committed = call("work", plan)
    const answer = (await writeHandler(deps).run({ planId: "minted-by-the-register" }, committed.call)) as Record<string, unknown>
    expect(answer).toMatchObject({ state: "ok", action: "runtime.create" })
    expect(fakes.ledger.runtimes.size).toBe(1)
    expect(committed.events).toEqual([{ name: "changed", data: { capability: "colab.runtimes", account: "work", reason: "write" } }])
  })

  test("plan_delete commits through the one release function", async () => {
    const { deps, fakes } = fakeDeps({ options: { access: "all", accounts: { work: { access: "write" } } } })
    await deps.ledger.putRuntime(runtime())
    const plan = (await planDeleteHandler(deps).run({ action: "runtime.delete", params: { runtime: "oc-work" } }, call("work").call)) as Record<string, unknown>
    expect(plan.method).toBe("delete")
    const committed = call("work", plan)
    await deleteHandler(deps).run({ planId: "minted-by-the-register" }, committed.call)
    expect(fakes.release.released).toEqual([{ id: "oc-work", reason: "plan", force: false }])
  })

  test("a plan of the other category and an unknown plan are refused", async () => {
    const { deps } = fakeDeps({ options: { access: "all", accounts: { work: { access: "write" } } } })
    await expect(planWriteHandler(deps).run({ action: "runtime.delete", params: { runtime: "oc-work" } }, call("work").call)).rejects.toMatchObject({
      refusal: { code: "PLAN_INVALID" },
    })
    await expect(writeHandler(deps).run({ planId: "x" }, call("work").call)).rejects.toMatchObject({ refusal: { code: "PLAN_INVALID" } })
  })

  test("a read account makes no plan", async () => {
    const { deps } = fakeDeps({ options: { access: "all", accounts: { work: { access: "read" } } } })
    await expect(planWriteHandler(deps).run({ action: "runtime.create", params: { spec: CPU } }, call("work").call)).rejects.toMatchObject({
      refusal: { code: "PERMISSION_DENIED" },
    })
  })
})
