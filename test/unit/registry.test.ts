// The registry and the wrapper: one handler per tool, in its owner's module; one plan handler per plan action and
// backend; the wrapper's single assert, its resources and ask metadata, `colab.read` through providerRead, errors as
// results, and changes never as tools RPC methods.
import { describe, expect, it } from "vitest"
import { actionOf, OPERATIONS, PLAN_ACTIONS, READ_ACTION, TOOLS } from "../../src/domain/actions.js"
import { CONTRACTS, type ToolName } from "../../src/domain/contract.js"
import { ColabError } from "../../src/domain/errors.js"
import { mergedPlanHandlers, PACKAGE_HANDLERS, PACKAGE_PLAN_HANDLERS, toolHandlers } from "../../src/tools/registry.js"
import { buildTool, runTool, type Runner, scriptMethod } from "../../src/tools/spec.js"
import type { HandlerContext, ToolHandler } from "../../src/tools/types.js"
import { METHOD_NAMES, methods } from "../../src/tools-rpc.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"

const call = (id = "call_1") => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id, signal: new AbortController().signal })

function runnerWith(override: Partial<Record<ToolName, ToolHandler<ToolName>>> = {}, options?: unknown) {
  const { deps, fakes } = fakeDeps({ options })
  const permission = new RecordingPermission()
  let runner: Runner
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => override[name] ?? handlers[name] }
  return { runner, permission, deps, fakes }
}

describe("the registry", () => {
  it("has exactly one handler per tool, in the module of the package that owns it", () => {
    for (const tool of TOOLS) {
      const owners = Object.entries(PACKAGE_HANDLERS).filter(([, handlers]) => tool.name in handlers).map(([owner]) => owner)
      expect(owners, tool.name).toEqual(tool.owner === "Day0" ? [] : [tool.owner])
    }
    const claimed = Object.values(PACKAGE_HANDLERS).flatMap((handlers) => Object.keys(handlers))
    expect(claimed.sort()).toEqual(TOOLS.filter((tool) => tool.owner !== "Day0").map((tool) => tool.name).sort())
    expect(Object.keys(CONTRACTS).sort()).toEqual(TOOLS.map((tool) => tool.name).sort())
  })

  it("has exactly one plan handler per action and backend, from the owner PLAN_ACTIONS names", () => {
    const merged = mergedPlanHandlers()
    for (const [action, entry] of Object.entries(PLAN_ACTIONS)) {
      for (const [backend, handlerEntry] of Object.entries(entry.backends)) {
        expect(merged[action as keyof typeof merged]?.[backend as "colab"], `${action} on ${backend}`).toBeDefined()
        const owners = Object.entries(PACKAGE_PLAN_HANDLERS).filter(([, handlers]) => handlers?.[action as keyof typeof handlers]?.[backend as "colab"]).map(([owner]) => owner)
        expect(owners, `${action} on ${backend}`).toEqual([handlerEntry.owner])
      }
    }
  })
})

describe("the wrapper", () => {
  it("asserts colab.run once, on the execute operation and the runtime, with the handler's ask metadata", async () => {
    const { runner, permission } = runnerWith({
      run: { metadata: async () => ({ preview: ["print(1)"] }), run: async () => ({ state: "ok", runId: "r1", cells: [], files: [] }) } as never,
    })
    const result = await runTool("run", { runtime: "oc-01", code: "print(1)" }, call(), runner)
    expect(result).toMatchObject({ state: "ok", runId: "r1" })
    expect(permission.requests).toHaveLength(1)
    expect(permission.requests[0]).toMatchObject({
      action: "colab.run",
      resources: [`default:${OPERATIONS.kernelsExecute}`, "default:runtime:oc-01"],
      save: [`default:${OPERATIONS.kernelsExecute}`, "default:runtime:oc-01"],
      metadata: { account: "default", preview: ["print(1)"] },
      source: { type: "tool", messageID: "msg_test", id: "call_1" },
    })
  })

  it("asserts reads on the account, and colab.read once per provider operation", async () => {
    const { runner, permission } = runnerWith({
      runtimes: {
        run: async (_input: unknown, ctx: HandlerContext) => {
          await ctx.providerRead(OPERATIONS.runtimesList)
          await ctx.providerRead(OPERATIONS.runtimesList)
          await ctx.providerRead(OPERATIONS.kernelsList)
          return { state: "ok", runtimes: [] }
        },
      } as never,
    })
    await runTool("runtimes", {}, call(), runner)
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.runtimes", ["default"]],
      [READ_ACTION, [`default:${OPERATIONS.runtimesList}`]],
      [READ_ACTION, [`default:${OPERATIONS.kernelsList}`]],
    ])
  })

  it("runs nothing when the assert is denied, and lets the host's denial through", async () => {
    let ran = false
    const { runner, permission } = runnerWith({ run: { run: async () => ((ran = true), { state: "ok", runId: "r", cells: [], files: [] }) } as never })
    permission.denyAll()
    await expect(runTool("run", { runtime: "oc-01", code: "x" }, call(), runner)).rejects.toThrow(/denied/)
    expect(ran).toBe(false)
  })

  it("answers a schema error, an unknown account and a handler's ColabError as results, before or without asserting", async () => {
    const { runner, permission } = runnerWith({ jobs: { run: async () => Promise.reject(new ColabError("RATE_LIMITED", "Quota.", { retryAfterSec: 30 })) } as never }, { accounts: { work: { backend: "enterprise" }, home: {} } })
    expect(await runTool("run", { runtime: "oc-01" }, call(), runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect(await runTool("jobs", { account: "nope" }, call(), runner)).toMatchObject({ state: "refused", error: "ACCOUNT_UNKNOWN" })
    expect(await runTool("jobs", {}, call(), runner)).toMatchObject({ state: "refused", error: "ACCOUNT_REQUIRED" })
    expect(permission.requests).toHaveLength(0)
    // `work` is a named account, so its access is read: a read tool still asserts and runs on it.
    expect(await runTool("jobs", { account: "work" }, call(), runner)).toEqual({ state: "failed", error: "RATE_LIMITED", message: "Quota.", next: "Make the same call after that delay.", retryAfterSec: 30 })
  })

  it("never offers Always for colab.delete, and does for colab.write", async () => {
    const { runner, permission, deps } = runnerWith()
    for (const category of ["write", "delete"] as const) {
      const plan = deps.plans.create({ action: category === "write" ? "runtime.create" : "runtime.delete", category, account: "default", backend: "colab", operation: category === "write" ? "colaboratory.runtimes.create" : "colaboratory.runtimes.delete", sessionId: "ses_test", agentId: "build", preview: { spec: "CPU" }, payload: {}, fingerprint: {} })
      await runTool(category, { planId: plan.id }, call(), runner)
    }
    expect(permission.requests.map((request) => [request.action, request.save])).toEqual([
      ["colab.write", ["default:colaboratory.runtimes.create"]],
      ["colab.delete", undefined],
    ])
  })

  it("registers each tool with its namespace, action and exposure", () => {
    const { runner } = runnerWith()
    for (const tool of TOOLS) {
      const built = buildTool(tool.name as ToolName, runner)
      expect(built.name).toBe(tool.name)
      expect(built.options).toEqual({ namespace: "colab", permission: actionOf(tool.name), codemode: tool.class === "read" })
    }
  })

  it("exposes the reads and the probe as tools RPC methods, and never a change", () => {
    const { runner } = runnerWith()
    expect(methods(runner).map((method) => method.name)).toEqual([...METHOD_NAMES])
    expect(METHOD_NAMES).toEqual([...TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.name), "probe"])
    for (const tool of TOOLS.filter((entry) => entry.class !== "read")) expect(() => scriptMethod(tool.name as ToolName, runner)).toThrow(/never a tools RPC method/)
  })
})
