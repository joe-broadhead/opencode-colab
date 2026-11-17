// Package B's runtime protocol: the "ours only" fence, the URL and token checks, `allow_stdin: false`, the
// `colab_request` decline, the proxy token on the upgrade, a token refresh and the runtime's files (design §16 row B:
// "runtime protocol (REST + kernel WebSocket, token and URL checks, allow_stdin false, colab_request decline, the
// watchdog)"; §15.1 agent-only runtimes, capture as transport; L2, L9, H6).
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { IopubMessage } from "../../src/ports.js"
import { createRuntimeFixture, PROXY_TOKEN, RUNTIME_ID } from "../fakes/runtime-env.js"

const fresh = () => new AbortController().signal

const collect = async (stream: AsyncIterable<IopubMessage>): Promise<IopubMessage[]> => {
  const messages: IopubMessage[] = []
  for await (const message of stream) messages.push(message)
  return messages
}

const failureOf = async (work: Promise<unknown>, signal = fresh()): Promise<ColabError | undefined> => {
  void signal
  try {
    await work
  } catch (error) {
    return error instanceof ColabError ? error : undefined
  }
}

describe("the runtime protocol", () => {
  it("proves the transport fence: no session, kernel list or file read on a runtime the plugin did not create", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const target = { account: "default", runtimeId: "oc-someone-elses" }
      expect((await failureOf(fixture.ports.runtime.openSession(target, { name: "oc-nonce-1-run", path: "/content/x.ipynb" }, fresh())))?.code).toBe("RUNTIME_NOT_OURS")
      expect((await failureOf(fixture.ports.runtime.kernels(target, fresh())))?.code).toBe("RUNTIME_NOT_OURS")
      expect((await failureOf(fixture.ports.runtime.sessions(target, fresh())))?.code).toBe("RUNTIME_NOT_OURS")
      expect((await failureOf(fixture.ports.runtime.files.list(target, "/content", fresh())))?.code).toBe("RUNTIME_NOT_OURS")
      // Not one request reached the runtime: the fence is before the network.
      expect(fixture.jupyter.requests).toEqual([])
      expect(fixture.api.requests).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it("refuses another account's runtime, a released runtime and a tainted one, with its own code", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own(RUNTIME_ID, { account: "work" })
      expect((await failureOf(fixture.ports.runtime.kernels({ account: "default", runtimeId: RUNTIME_ID }, fresh())))?.code).toBe("RUNTIME_NOT_OURS")
      await fixture.own(RUNTIME_ID, { state: "released" })
      expect((await failureOf(fixture.ports.runtime.kernels({ account: "default", runtimeId: RUNTIME_ID }, fresh())))?.code).toBe("RUNTIME_GONE")
      await fixture.own(RUNTIME_ID, { tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: "2026-11-17T09:05:00.000Z" } })
      expect((await failureOf(fixture.ports.runtime.kernels({ account: "default", runtimeId: RUNTIME_ID }, fresh())))?.code).toBe("RUNTIME_HAS_CREDENTIALS")
    } finally {
      await fixture.close()
    }
  })

  it("opens a kernel session and executes with allow_stdin false, yielding iopub by parent request until idle", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const messages = await collect(session.execute("print(1)", { allowStdin: false, silent: false, storeHistory: true }, fresh()))
      expect(messages.map((message) => message.msgType)).toEqual(["stream", "status"])
      expect(messages[0]?.content).toMatchObject({ name: "stdout", text: "1\n" })
      expect(messages.every((message) => message.parentMsgId.length > 0)).toBe(true)
      expect(messages.at(-1)?.content).toMatchObject({ execution_state: "idle" })
      expect(fixture.jupyter.executed.at(-1)).toMatchObject({ allowStdin: false, silent: false })
      await session.close()
    } finally {
      await fixture.close()
    }
  })

  it("passes iopub through as the capture layer needs it: stream, display_data, execute_result and error, in order", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      fixture.jupyter.emit.set("plot", [
        { msgType: "display_data", content: { data: { "image/png": "aGVsbG8=" }, metadata: {} } },
        { msgType: "execute_result", content: { data: { "text/plain": "42" }, execution_count: 7 } },
        { msgType: "error", content: { ename: "ValueError", evalue: "bad", traceback: ["Traceback"] } },
      ])
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const messages = await collect(session.execute("# plot", { allowStdin: false, silent: false, storeHistory: true }, fresh()))
      expect(messages.map((message) => message.msgType)).toEqual(["stream", "display_data", "execute_result", "error", "status"])
      expect(messages[1]?.content).toEqual({ data: { "image/png": "aGVsbG8=" }, metadata: {} })
      expect(messages[2]?.content).toMatchObject({ execution_count: 7 })
      expect(messages[3]?.content).toMatchObject({ ename: "ValueError" })
      expect(new Set(messages.map((message) => message.parentMsgId)).size).toBe(1)
      await session.close()
    } finally {
      await fixture.close()
    }
  })

  it("L9: declines every colab_request in the same tick with the colab_reply colab-vscode sends", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const started = Date.now()
      const messages = await collect(session.execute("from google.colab import drive\ndrive.mount('/content/drive')", { allowStdin: false, silent: false, storeHistory: true }, fresh()))
      expect(Date.now() - started).toBeLessThan(1_000)
      // The request is still yielded, so capture can report COLAB_UI_API.
      expect(messages.some((message) => message.msgType === "colab_request")).toBe(true)
      // And the kernel heard the decline, not the fake's "the plugin did not answer" fallback.
      expect(fixture.jupyter.replies[0]).toEqual({ type: "colab_reply", colab_msg_id: 1, error: "not available in opencode-colab" })
      const error = messages.find((message) => message.msgType === "error")
      expect(String(error?.content.evalue)).toBe("not available in opencode-colab")
      await session.close()
    } finally {
      await fixture.close()
    }
  })

  it("sends the proxy token on the WebSocket upgrade and keeps one session per name", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const target = { account: "default", runtimeId: RUNTIME_ID }
      const first = await fixture.ports.runtime.openSession(target, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const second = await fixture.ports.runtime.openSession(target, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      expect(second.session.kernelId).toBe(first.session.kernelId)
      expect(await fixture.ports.runtime.sessions(target, fresh())).toHaveLength(1)
      expect(fixture.jupyter.upgrades).toHaveLength(1)
      expect(fixture.jupyter.upgrades[0]?.headers["x-colab-runtime-proxy-token"]).toBe(PROXY_TOKEN)
      expect(fixture.jupyter.upgrades[0]?.path).toMatch(/^\/api\/kernels\/[^/]+\/channels\?session_id=/)
      await first.close()
      await second.close()
    } finally {
      await fixture.close()
    }
  })

  it("refreshes an expired proxy token once and retries the call", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const target = { account: "default", runtimeId: RUNTIME_ID }
      expect(await fixture.ports.runtime.kernels(target, fresh())).toHaveLength(0)
      fixture.jupyter.revoke(PROXY_TOKEN)
      fixture.api.rotateProxyToken("proxy-token-2")
      fixture.jupyter.addToken("proxy-token-2")
      expect(await fixture.ports.runtime.kernels(target, fresh())).toHaveLength(0)
      // The runtime was asked for fresh connection information, as design §7.4 requires.
      expect(fixture.api.requests.filter((request) => request.path === `v1beta/runtimes/${RUNTIME_ID}`).length).toBeGreaterThanOrEqual(2)
      expect(fixture.jupyter.requests.at(-1)?.headers["x-colab-runtime-proxy-token"]).toBe("proxy-token-2")
    } finally {
      await fixture.close()
    }
  })

  it("refuses a runtime URL that is not https on an allowed Google host, before any connection", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      fixture.api.setRuntimeUrl(RUNTIME_ID, "https://evil.example.com/runtime")
      const failure = await failureOf(fixture.ports.runtime.kernels({ account: "default", runtimeId: RUNTIME_ID }, fresh()))
      expect(failure?.code).toBe("RUNTIME_UNVERIFIED")
      expect(failure?.message).not.toContain("evil.example.com")
      expect(fixture.jupyter.requests).toEqual([])
      expect(fixture.jupyter.upgrades).toEqual([])
    } finally {
      await fixture.close()
    }
  })

  it("H4: a call's own signal stops the run, and ends the stream with CANCELLED rather than a quiet finish", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const controller = new AbortController()
      const messages = (async () => {
        const seen: IopubMessage[] = []
        for await (const message of session.execute("# hang", { allowStdin: false, silent: false, storeHistory: true }, controller.signal)) {
          seen.push(message)
          if (seen.length === 1) controller.abort()
        }
        return seen
      })()
      const failure = await messages.catch((error: unknown) => error)
      expect((failure as ColabError).code).toBe("CANCELLED")
      await session.interrupt(fresh())
      expect(fixture.jupyter.interrupts).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  })

  it("L6: never replays another request's iopub, so a run's stream is its own", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      const messages = await collect(session.execute("# stale", { allowStdin: false, silent: false, storeHistory: true }, fresh()))
      expect(messages.map((message) => message.msgType)).toEqual(["stream", "status"])
      expect(messages.some((message) => message.content.text === "replayed\n")).toBe(false)
      expect(new Set(messages.map((message) => message.parentMsgId)).size).toBe(1)
    } finally {
      await fixture.close()
    }
  })

  it("writes and reads a runtime file with a contents write and a ranged file read", async () => {
    const fixture = await createRuntimeFixture({ allowHidden: true })
    try {
      await fixture.own()
      const target = { account: "default", runtimeId: RUNTIME_ID }
      const payload = new TextEncoder().encode("value\n1,2,3\n")
      const written = await fixture.ports.runtime.files.write(target, "/content/outputs/data.csv", (async function* () {
        yield payload
      })(), fresh())
      expect(written.bytes).toBe(payload.byteLength)
      const chunks: Uint8Array[] = []
      for await (const chunk of await fixture.ports.runtime.files.read(target, "/content/outputs/data.csv", fresh())) chunks.push(chunk)
      expect(Buffer.concat(chunks).toString("utf8")).toBe("value\n1,2,3\n")
      expect(fixture.jupyter.requests.some((request) => request.headers["range"] === "bytes=0-")).toBe(true)
      const listed = await fixture.ports.runtime.files.list(target, "/content/outputs", fresh())
      expect(listed?.map((entry) => entry.path)).toEqual(["content/outputs/data.csv"])
    } finally {
      await fixture.close()
    }
  })

  it("lists a hidden folder only when the runtime's REST can see hidden paths (L2)", async () => {
    const blind = await createRuntimeFixture({ allowHidden: false })
    const visible = await createRuntimeFixture({ allowHidden: true })
    try {
      await blind.own()
      await visible.own()
      const target = { account: "default", runtimeId: RUNTIME_ID }
      expect(await blind.ports.runtime.files.list(target, "content/.config", fresh())).toBeUndefined()
      expect(await visible.ports.runtime.files.list(target, "content/.config", fresh())).toBeDefined()
    } finally {
      await blind.close()
      await visible.close()
    }
  })

  it("reports a dead kernel rather than ending the stream quietly", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession({ account: "default", runtimeId: RUNTIME_ID }, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, fresh())
      await session.close()
      expect((await failureOf(collect(session.execute("print(1)", { allowStdin: false, silent: false, storeHistory: false }, fresh()))))?.code).toBe("KERNEL_DIED")
    } finally {
      await fixture.close()
    }
  })
})
