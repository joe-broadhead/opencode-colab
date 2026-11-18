// The sources through the tools RPC, end to end (colab-16, LOW 3): `methods(runner)` registered with the source
// contract's own transport (`registerToolsRpc`) on a fake host, called the way a script calls it. Request 2: `probe`
// reaches the plugin's runner and answers `colab.runs`' local owner. Request 3: a source refusal thrown by a script
// method (`scriptMethod` → the tool wrapper → the handler) reaches the script as the RPC error `failed`, with the
// contract's code and next step.
import { registerToolsRpc } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { describe, expect, it } from "vitest"
import { encodeRunsCursor, PACKAGE } from "../../src/sources/index.js"
import { localOwner } from "../../src/sources/owner.js"
import { methods, PLUGIN } from "../../src/tools-rpc.js"
import { HOME, LAB, sourcesHarness } from "../fakes/sources-harness.js"

type Handler = (raw: unknown, context: { signal: AbortSignal; error: (name: string, message: string, data: unknown) => unknown }) => Promise<unknown>

/** A host that registers the tools RPC and resolves one session whose agent allows everything. */
async function rpcFor(runner: ReturnType<typeof sourcesHarness>["runner"]) {
  let handlers: Record<string, Handler> = {}
  const disposable = { dispose: async () => undefined }
  const ctx = {
    location: { directory: "/project" },
    rpc: {
      register: async (_contract: unknown, implementation: Record<string, Handler>) => {
        handlers = implementation
        return disposable
      },
    },
    permission: { hook: async () => disposable },
    session: { get: async () => ({ agent: "build", permissions: [] }) },
    agent: { get: async () => ({ data: { permissions: [{ action: "*", resource: "*", effect: "allow" }] } }) },
    mcp: { list: async () => ({ data: [] }) },
    tool: { list: async () => [] },
  }
  await registerToolsRpc(ctx as never, { plugin: PLUGIN, methods: methods(runner) })
  const context = { signal: new AbortController().signal, error: (name: string, message: string, data: unknown) => ({ rpcError: name, message, data }) }
  return (method: string, input: Record<string, unknown>) => handlers[method]!({ sessionID: "ses_script", input }, context)
}

describe("the sources through the tools RPC", () => {
  it("probe for runs answers this computer's owner, through methods(runner)", async () => {
    const h = sourcesHarness()
    const call = await rpcFor(h.runner)
    expect(await call("probe", { source: "runs", account: HOME })).toEqual({ source: "runs", account: HOME, owner: localOwner(), trust: "untrusted" })
    expect(h.permission.requests.map((request) => request.action)).toEqual(["colab.probe"])
  })

  it("a cursor another account's source issued reaches the script as failed, with CURSOR_INVALID and its next step", async () => {
    const h = sourcesHarness()
    const call = await rpcFor(h.runner)
    const answer = (await call("events_list", { source: "runs", account: HOME, cursor: encodeRunsCursor(LAB, { q: 1, t: "2026-11-17T09:00:00.000Z" }) })) as { rpcError: string; message: string; data: { code: string; next: string } }
    expect(answer.rpcError).toBe("failed")
    expect(answer.data.code).toBe("CURSOR_INVALID")
    expect(answer.data.next).toBe("Call events_list again without a cursor, with since, to start over.")
    expect(answer.message).toMatch(/^CURSOR_INVALID: /)
  })

  it("a page still answers as a page", async () => {
    const h = sourcesHarness()
    const call = await rpcFor(h.runner)
    expect(await call("events_list", { source: "runs", account: HOME })).toMatchObject({ source: "runs", account: HOME, plugin: PACKAGE, events: [], more: false, trust: "untrusted" })
  })
})
