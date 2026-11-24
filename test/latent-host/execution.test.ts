// H5, H7 and H11 in a real embedded host, on every tested release (test/host runs this file once per SDK):
//
// - H5: the read tools are registered for Code Mode and a read runs through the host's own tool object, with no request
//   leaving the machine (the harness fails the host if one does).
// - H7: the wait bound the plugin uses (`B`, 240 s) and the tools' schema cap are accepted by the host's tool layer; the
//   call itself answers through the host. The family measures the host's longest call separately; a live run needs a
//   Colab runtime, which no test may use.
// - H11: at ask-changes, colab_run's ask carries the code preview — each cell's first lines and the sources' sha256 —
//   and the run is asserted exactly once.
import { afterAll, describe, expect, test } from "bun:test"
import { cleanup, startHost, until } from "./harness.js"

afterAll(cleanup)

/** A tool's execute context: a real session in the host, a unique call, and a no-op progress channel. */
const context = (sessionID: string, index: number) =>
  ({
    sessionID,
    agent: "build",
    messageID: `msg_hostexec_${index}`,
    id: `call_hostexec_${index}`,
    progress: async () => undefined,
    signal: AbortSignal.timeout(15_000),
  }) as never

const execute = async (host: Awaited<ReturnType<typeof startHost>>, id: string, input: unknown, index: number) => {
  // The host resolves the session's agent and rules for the assert, so the call runs in a real session.
  const session = await host.client.session.create({ agent: "build", location: host.location, title: "package D host test" })
  const tool = await until(`the ${id} tool is registered`, async () => host.probe().tool.list().then((list) => list.find((entry) => entry.id === id)))
  return (await (tool.execute as (input: unknown, context: unknown) => Promise<unknown>)(input, context(session.id, index))) as { output?: Record<string, unknown>; content?: string; metadata?: Record<string, unknown> }
}

describe("package D in a host", () => {
  test("H5 — the reads are Code Mode tools, the changes are not, and a read runs through the host", async () => {
    const host = await startHost()
    try {
      const tools = await host.probe().tool.list()
      const byId = new Map(tools.map((tool) => [tool.id, tool]))
      for (const id of ["colab_specs", "colab_runtimes", "colab_files", "colab_execution"]) expect(byId.get(id)?.options?.codemode, id).toBe(true)
      for (const id of ["colab_run", "colab_cancel", "colab_upload", "colab_download"]) expect(byId.get(id)?.options?.codemode, id).toBe(false)

      // A read through the host's tool object: the runtime is not in the plugin's ledger, so it refuses before any
      // request. No token, no runtime, no Google call.
      const answer = await execute(host, "colab_files", { runtime: "oc-hostdoesnotexist" }, 1)
      expect(answer.output).toMatchObject({ state: "refused", error: "RUNTIME_NOT_OURS" })
      expect(answer.content).toContain("RUNTIME_NOT_OURS")
    } finally {
      await host.close()
    }
  }, 120_000)

  test("H7 — the wait bound and the tools' cap reach the host's call layer", async () => {
    const host = await startHost()
    try {
      // `B` (240 s) is what colab_run and colab_execution wait at most; the schema accepts it and the host passes it
      // through without capping it. An unknown run answers at once, so the call completes well inside the host's limit.
      const answer = await execute(host, "colab_execution", { runId: "01jhostdoesnotexist", wait: 240 }, 2)
      expect(answer.output).toMatchObject({ state: "refused", error: "NOT_FOUND" })
      const run = await execute(host, "colab_run", { runtime: "oc-hostdoesnotexist", code: "print(1)", wait: 240, timeoutSec: 21600 }, 3)
      expect(run.output).toMatchObject({ state: "refused", error: "RUNTIME_NOT_OURS" })
    } finally {
      await host.close()
    }
  }, 120_000)

  test("H11 — at ask-changes, the run's one ask carries the code preview", async () => {
    const host = await startHost({ options: { access: "ask-changes" } })
    try {
      const pending = execute(host, "colab_run", { runtime: "oc-hostdoesnotexist", code: "import requests\n%pip install -q pandas\nprint(1)\n2\n3\n4\n5", wait: 0 }, 4)
      const request = await until(
        "the colab.run ask",
        async () => (await host.client.permission.request.list({ location: host.location })).data.find((entry) => entry.action === "colab.run"),
        30_000,
      )
      const metadata = request.metadata as { cells?: { id: string; lines: string[]; sha256: string; flags?: { flag: string }[] }[] }
      expect(metadata.cells).toHaveLength(1)
      expect(metadata.cells![0]!.id).toBe("code")
      expect(metadata.cells![0]!.lines).toEqual(["import requests", "%pip install -q pandas", "print(1)", "2", "3", "4"])
      expect(metadata.cells![0]!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(metadata.cells![0]!.flags?.map((flag) => flag.flag)).toEqual(expect.arrayContaining(["install", "network"]))
      // Nothing the agent wrote reaches the message: the ask carries the preview and the run refuses the unknown runtime.
      await host.client.permission.reply({ sessionID: request.sessionID, requestID: request.id, decision: "once" })
      const answer = await pending
      expect(answer.output).toMatchObject({ state: "refused", error: "RUNTIME_NOT_OURS" })
      // One ask per run, and no second ask from the probe or the session (they never ran: the runtime is unknown).
      const asks = (await host.client.permission.request.list({ location: host.location })).data.filter((entry) => entry.action === "colab.run")
      expect(asks).toHaveLength(0)
    } finally {
      await host.close()
    }
  }, 120_000)
})
