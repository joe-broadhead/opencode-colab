// H6: the host's runtime opens a kernel WebSocket with Colab's proxy-token header, and a live session survives a token
// refresh. This runs under the same runtime OpenCode hosts the plugin in (Bun, one per tested SDK in scripts/check.mjs),
// against the loopback proxy and Jupyter fakes, so nothing leaves the machine.
//
// A refresh in Colab is: the proxy token expires (the runtime proxy answers 404), the plugin calls `runtimes.get` for a
// new `connectionInfo`, and the next REST call carries the new token. The WebSocket opened before the refresh keeps
// working: Google's CLI documents that a long-lived connection presents the token only at connect (design §1, [5]).
import { afterAll, describe, expect, test } from "bun:test"
import type { KernelSession } from "../../src/ports.js"
import { probeSnippet } from "../../src/runtime/probe.js"
import { createColabApi } from "../../src/runtime/api.js"
import { createRuntimeProtocol } from "../../src/runtime/protocol.js"
import type { PortEnv } from "../../src/deps.js"
import { loadOptions } from "../../src/options.js"
import { FakeAuth, FakeClock, MemoryLedger } from "../fakes/index.js"
import { createFakeColabApi } from "../fakes/runtime-api.js"
import { createFakeJupyter } from "../fakes/runtime-jupyter.js"

const PROXY_TOKEN = "proxy-token-host"
const RUNTIME = "oc-01jhostruntime0000000000"
const CPU = { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } as const
const open: { close(): Promise<void> }[] = []

afterAll(async () => {
  for (const item of open) await item.close()
})

describe("the host runtime and Colab's kernel channel", () => {
  test("opens a WebSocket with the proxy-token header and keeps the session across a token refresh", async () => {
    // The runtime OpenCode gives a plugin has a WebSocket whose constructor takes headers; without it the transport
    // could not authenticate the upgrade at all.
    expect(typeof WebSocket).toBe("function")

    const jupyter = await createFakeJupyter({ token: PROXY_TOKEN })
    const api = await createFakeColabApi({ runtimeUrl: jupyter.url, runtimeToken: PROXY_TOKEN })
    open.push(jupyter, api)
    const options = loadOptions({})
    const auth = new FakeAuth()
    auth.grants.set("default", ["https://www.googleapis.com/auth/colaboratory"])
    const ledger = new MemoryLedger()
    const clock = new FakeClock()
    // Nothing but the two loopback fakes: a request to any other origin fails this test's env.
    const env: PortEnv = {
      options,
      directory: process.cwd(),
      clock,
      auth,
      ledger,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request.toString() : request.url)
        if (url.origin === new URL(jupyter.url).origin) return globalThis.fetch(request as RequestInfo, init)
        if (url.origin !== "https://colaboratory.googleapis.com") throw new Error(`EXTERNAL_FETCH_BLOCKED: ${url.origin}`)
        return globalThis.fetch(new URL(`${api.url}${url.pathname}${url.search}`), init)
      }) as unknown as typeof fetch,
    }
    const colab = createColabApi(env, { retryDelaysMs: [0, 0], operationPollMs: 0 })
    const protocol = createRuntimeProtocol(env, colab, { allowLoopback: true })
    await ledger.putRuntime({
      id: RUNTIME,
      account: "default",
      backend: "colab",
      spec: CPU,
      createdAt: new Date().toISOString(),
      nonce: "nonce-host",
      keep: ["/content/outputs/**"],
      lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
      state: "ready",
    })
    api.runtimes.set(RUNTIME, { id: RUNTIME, spec: { ...CPU, eligible: true }, requestId: "request-host", connection: { url: jupyter.url, token: PROXY_TOKEN, expireTime: new Date(Date.now() + 3_600_000).toISOString() } })
    const target = { account: "default", runtimeId: RUNTIME }
    const signal = new AbortController().signal

    const session = (await protocol.openSession(target, { name: "oc-nonce-host-run", path: "/content/analysis.ipynb" }, signal)) as KernelSession
    expect(jupyter.upgrades).toHaveLength(1)
    expect(jupyter.upgrades[0]?.headers["x-colab-runtime-proxy-token"]).toBe(PROXY_TOKEN)

    const first: string[] = []
    for await (const message of session.execute("print(1)", { allowStdin: false, silent: false, storeHistory: true }, signal)) first.push(message.msgType)
    expect(first).toEqual(["stream", "status"])

    // The token expires and Google hands out a new one on the next `runtimes.get`.
    jupyter.revoke(PROXY_TOKEN)
    api.rotateProxyToken("proxy-token-host-2")
    jupyter.addToken("proxy-token-host-2")
    await session.interrupt(signal)
    expect(jupyter.interrupts).toHaveLength(1)
    expect(jupyter.requests.at(-1)?.headers["x-colab-runtime-proxy-token"]).toBe("proxy-token-host-2")

    // The socket opened before the refresh is still the one carrying messages: no second upgrade, one session.
    const second: string[] = []
    for await (const message of session.execute(probeSnippet(), { allowStdin: false, silent: true, storeHistory: false }, signal)) second.push(message.msgType)
    expect(second).toEqual(["stream", "status"])
    expect(jupyter.upgrades).toHaveLength(1)
    expect((await protocol.sessions(target, signal)).map((entry) => entry.name)).toEqual(["oc-nonce-host-run"])

    await session.close()
  }, 60_000)

  test("refuses a runtime URL on a host that is not Google's, from inside the host runtime", async () => {
    const jupyter = await createFakeJupyter({ token: PROXY_TOKEN })
    const api = await createFakeColabApi({ runtimeUrl: jupyter.url, runtimeToken: PROXY_TOKEN })
    open.push(jupyter, api)
    const options = loadOptions({})
    const auth = new FakeAuth()
    auth.grants.set("default", ["https://www.googleapis.com/auth/colaboratory"])
    const ledger = new MemoryLedger()
    const env: PortEnv = {
      options,
      directory: process.cwd(),
      clock: new FakeClock(),
      auth,
      ledger,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request.toString() : request.url)
        if (url.origin === new URL(jupyter.url).origin) return globalThis.fetch(request as RequestInfo, init)
        return globalThis.fetch(new URL(`${api.url}${url.pathname}${url.search}`), init)
      }) as unknown as typeof fetch,
    }
    const colab = createColabApi(env, { retryDelaysMs: [0, 0], operationPollMs: 0 })
    const protocol = createRuntimeProtocol(env, colab, { allowLoopback: true })
    await ledger.putRuntime({
      id: RUNTIME,
      account: "default",
      backend: "colab",
      spec: CPU,
      createdAt: new Date().toISOString(),
      nonce: "nonce-host",
      keep: [],
      lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
      state: "ready",
    })
    api.runtimes.set(RUNTIME, { id: RUNTIME, spec: { ...CPU, eligible: true }, requestId: "request-host", connection: { url: jupyter.url, token: PROXY_TOKEN, expireTime: new Date(Date.now() + 3_600_000).toISOString() } })
    api.setRuntimeUrl(RUNTIME, "https://evil.example.com/runtime")
    const failure = await protocol.kernels({ account: "default", runtimeId: RUNTIME }, new AbortController().signal).catch((error: unknown) => error)
    expect(String((failure as Error).message)).toContain("RUNTIME_UNVERIFIED")
    expect(jupyter.upgrades).toHaveLength(0)
    expect(jupyter.requests).toHaveLength(0)
  }, 60_000)
})
