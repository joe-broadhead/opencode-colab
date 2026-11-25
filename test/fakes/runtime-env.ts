/**
 * One fixture for package B's tests: the loopback Colab API, the token-checking proxy in front of the Jupyter fake, a
 * `PortEnv` wired to both (fetch is routed to the API fake's origin; every other host is refused), the package's real
 * ports sharing one owner lease, and a ledger record for a runtime of the plugin's own. Nothing here reaches Google.
 *
 * `leaseDir` makes the lease file-backed, which is how two "processes" are simulated: two checks or protocols built on
 * the same directory see each other, exactly as two OpenCode processes would.
 */
import type { PortEnv } from "../../src/provider/index.js"
import { loadOptions, type Options } from "../../src/options.js"
import type { RuntimeRecord } from "../../src/provider/ports.js"
import type { ColabApiOptions } from "../../src/provider/runtime/api.js"
import { createAgentOnlyCheck, createColabApi, createRuntimeProtocol, type RuntimePorts } from "../../src/provider/runtime/index.js"
import { createOwnerLease, type OwnerLease } from "../../src/provider/runtime/lease.js"
import { FakeAuth, FakeClock, MemoryLedger } from "./index.js"
import { createFakeColabApi, type FakeColabApi } from "./runtime-api.js"
import { createFakeJupyter, type FakeJupyter } from "./runtime-jupyter.js"
import { invented } from "../support/invented.js"

export const CPU = { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } as const
export const PROXY_TOKEN = invented("proxy-token-", "1")
export const RUNTIME_ID = "oc-01jtestruntime0000000000"

export interface RuntimeFixture {
  readonly env: PortEnv
  readonly ports: RuntimePorts
  readonly options: Options
  readonly auth: FakeAuth
  readonly ledger: MemoryLedger
  readonly clock: FakeClock
  readonly api: FakeColabApi
  readonly jupyter: FakeJupyter
  readonly lease: OwnerLease
  /** Writes the ledger record that makes a runtime the plugin's own. */
  own(runtimeId?: string, record?: Partial<RuntimeRecord>): Promise<RuntimeRecord>
  /** A signal that can be aborted by the test. */
  signal(): AbortSignal
  close(): Promise<void>
}

export interface RuntimeFixtureInput {
  readonly allowHidden?: boolean
  readonly options?: unknown
  readonly createPolls?: number
  readonly proxyConnections?: number
  readonly fetch?: typeof fetch
  readonly colab?: ColabApiOptions
  /** A directory for the owner lease; two fixtures on one directory are two processes. */
  readonly leaseDir?: string
  /** A small contents-write piece size, so a chunked upload can be exercised with a few bytes. */
  readonly maxContentsBytes?: number
  /** A different process id, for a "second process" fixture. */
  readonly leasePid?: number
}

export const CLEAN_CALIBRATION_FIXTURE = {
  hiddenPathsVisible: false,
  baselineConnections: {},
  probeKernel: { id: "kernel-probe", executionCount: 1, startMs: 10, rttMs: 5 },
  snippetVersion: "fixture",
  at: "2026-11-17T09:00:00.000Z",
}

export async function createRuntimeFixture(input: RuntimeFixtureInput = {}): Promise<RuntimeFixture> {
  const jupyter = await createFakeJupyter({
    token: invented("proxy-token-", "1"),
    ...(input.allowHidden !== undefined ? { allowHidden: input.allowHidden } : {}),
    ...(input.proxyConnections !== undefined ? { proxyConnections: input.proxyConnections } : {}),
  })
  const api = await createFakeColabApi({ runtimeUrl: jupyter.url, runtimeToken: invented("proxy-token-", "1"), ...(input.createPolls !== undefined ? { createPolls: input.createPolls } : {}) })
  const options = loadOptions(input.options ?? {})
  const auth = new FakeAuth()
  auth.grants.set("default", ["https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/colaboratory.readonly"])
  auth.grants.set("work", ["https://www.googleapis.com/auth/colaboratory.readonly"])
  auth.emails.set("default", "person@example.test")
  const ledger = new MemoryLedger()
  const clock = new FakeClock()
  const routed = (async (request: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof request === "string" || request instanceof URL ? request.toString() : request.url)
    // The Colab API is routed to the loopback fake; the runtime's own origin is the proxy fake, allowed as it is.
    if (url.origin === new URL(jupyter.url).origin) return (input.fetch ?? globalThis.fetch)(request as RequestInfo, init)
    if (url.origin !== "https://colaboratory.googleapis.com") {
      throw new Error(`the fixture refuses a request to ${url.origin}`)
    }
    const target = new URL(`${api.url}${url.pathname}${url.search}`)
    return (input.fetch ?? globalThis.fetch)(target, init as RequestInit)
  }) as unknown as typeof fetch
  const env: PortEnv = { options, directory: "/project", clock, auth, ledger, fetch: routed }
  const lease = createOwnerLease({ ...(input.leaseDir !== undefined ? { dir: input.leaseDir } : {}), ...(input.leasePid !== undefined ? { pid: input.leasePid } : {}) })
  const colab = createColabApi(env, { retryDelaysMs: [0, 0], operationPollMs: 0, ...input.colab })
  // The loopback fakes are plain http on 127.0.0.1; production accepts only https on a Google host.
  const runtime = createRuntimeProtocol(env, colab, { allowLoopback: true, lease, ...(input.maxContentsBytes !== undefined ? { maxContentsBytes: input.maxContentsBytes } : {}) })
  const ports: RuntimePorts = { colab, runtime, check: createAgentOnlyCheck(env, runtime, { lease }) }
  const controller = new AbortController()

  return {
    env,
    ports,
    options,
    auth,
    ledger,
    clock,
    api,
    jupyter,
    lease,
    async own(runtimeId = RUNTIME_ID, record = {}) {
      const full: RuntimeRecord = {
        id: runtimeId,
        account: "default",
        backend: "colab",
        spec: CPU,
        createdAt: "2026-11-17T09:00:00.000Z",
        nonce: "nonce-1",
        keep: ["/content/outputs/**"],
        lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
        state: "ready",
        ...record,
      }
      await ledger.putRuntime(full)
      api.runtimes.set(runtimeId, {
        id: runtimeId,
        spec: { ...CPU, eligible: true },
        requestId: "request-1",
        connection: { url: jupyter.url, token: invented("proxy-token-", "1"), expireTime: new Date(Date.now() + 3_600_000).toISOString() },
      })
      return full
    },
    signal: () => controller.signal,
    async close() {
      lease.dispose()
      await Promise.all([api.close(), jupyter.close()])
    },
  }
}
