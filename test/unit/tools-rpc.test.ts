// The tools RPC's Day 0 part: the probe is built with the runner (colab-15 request 2), a source refusal reaches a
// script as the contract's own code (request 3), and the source tools throw the wrapper's refusals (request 4).
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it, vi } from "vitest"
import { toolHandlers } from "../../src/tools/registry.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { methods, pluginError } from "../../src/tools-rpc.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"

const seen: unknown[] = []
vi.mock("../../src/sources/index.js", async (original) => {
  const actual = (await original()) as Record<string, unknown> & { sourceMethods: (...args: unknown[]) => unknown[] }
  return { ...actual, sourceMethods: (...args: unknown[]) => (seen.push(...args), actual.sourceMethods(...args)) }
})

function runner(options?: unknown): Runner {
  const { deps } = fakeDeps({ options })
  let built: Runner
  const handlers = toolHandlers(() => built)
  built = { deps, assert: new RecordingPermission().assert, handler: (name) => handlers[name] }
  return built
}

const call = { sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_1", signal: new AbortController().signal }

describe("the tools RPC", () => {
  it("passes the runner to sourceMethods, so the probe reads through it", () => {
    const built = runner()
    seen.length = 0
    methods(built)
    expect(seen).toEqual([built])
  })

  it("answers a source refusal with the contract's code, what and next", () => {
    const refusal = new SourceError({ code: "CURSOR_INVALID", what: "The cursor is not this source's", next: "Call events_list without a cursor." })
    expect(pluginError(refusal)).toEqual({ code: "CURSOR_INVALID", what: "The cursor is not this source's", next: "Call events_list without a cursor." })
    expect(pluginError(new SourceError({ code: "RATE_LIMITED", what: "Quota", next: "Wait.", retryAfterSec: 30 }))).toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 30 })
  })

  it("throws the source tools' input and account refusals as SourceError, and still returns other tools' refusals", async () => {
    const built = runner({ accounts: { home: {}, work: { backend: "enterprise" } } })
    await expect(runTool("events_list", { source: "runs", limit: 0, account: "home" }, call, built)).rejects.toMatchObject({ code: "INPUT_INVALID" })
    await expect(runTool("events_list", { source: "runs", account: "nope" }, call, built)).rejects.toMatchObject({ code: "ACCOUNT_MISMATCH" })
    await expect(runTool("runtimes_read", {}, call, built)).rejects.toBeInstanceOf(SourceError)
    expect(await runTool("jobs", { account: "nope" }, call, built)).toMatchObject({ state: "refused", error: "ACCOUNT_UNKNOWN" })
  })
})
