/**
 * The loopback Colab API (design §15.2): `runtimes.create` with its LRO, `requestId` joins and client-chosen ids,
 * `get`/`list`/`delete`, runtime specs with eligibility, the subscription, and the failures the client maps — 429 with a
 * `Retry-After`, 5xx, `FAILED_PRECONDITION` with an `ErrorInfo` reason, and a disabled API. Its `connectionInfo` points
 * at `test/fakes/runtime-jupyter.ts`, so the whole transport runs against it with nothing leaving the machine.
 */
import type { Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"

export interface FakeSpec {
  readonly variant: "VARIANT_CPU" | "VARIANT_GPU" | "VARIANT_TPU"
  readonly shape: "SHAPE_STANDARD" | "SHAPE_HIGHMEM"
  readonly accelerator: string
  readonly eligible: boolean
}

export interface FakeRuntime {
  readonly id: string
  readonly spec: FakeSpec
  readonly requestId: string
  connection: { url: string; token: string; expireTime: string }
}

export interface FakeFailure {
  readonly status: number
  readonly body?: unknown
  readonly headers?: Readonly<Record<string, string>>
}

export interface FakeColabApiOptions {
  /** What `connectionInfo.url` points at: the token-checking proxy from the Jupyter fake. */
  readonly runtimeUrl: string
  readonly runtimeToken?: string
  /** How many `operations.get` polls a create takes before it is done. */
  readonly createPolls?: number
  /** Where the create's Operation name lives; both prefixes are served. */
  readonly operationName?: string
}

export interface FakeColabApi {
  readonly url: string
  readonly specs: FakeSpec[]
  tier: string
  /** The plugin's runtimes, by id. */
  readonly runtimes: Map<string, FakeRuntime>
  /** requestId → runtimeId, so a retried create joins. */
  readonly joins: Map<string, string>
  readonly requests: { readonly method: string; readonly path: string; readonly query: string; readonly body: string; readonly authorization?: string }[]
  /** How many `operations/{id}:wait` calls the client made. */
  readonly operationsWaited: number
  /** Fail the next `count` requests whose method and path match (default once). */
  failNext(match: { readonly method: string; readonly path: RegExp }, failure: FakeFailure, count?: number): void
  /** The token every new `connectionInfo` carries. */
  proxyToken: string
  /** Rotate the token `getRuntime` hands out, as a refresh does. */
  rotateProxyToken(next: string): void
  /** Point a runtime's connection URL somewhere else, to test the URL gate. */
  setRuntimeUrl(runtimeId: string, url: string): void
  close(): Promise<void>
}

const now = () => new Date().toISOString()

export async function createFakeColabApi(options: FakeColabApiOptions): Promise<FakeColabApi> {
  const specs: FakeSpec[] = [
    { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE", eligible: true },
    { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4", eligible: true },
    { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "A100", eligible: false },
  ]
  const runtimes = new Map<string, FakeRuntime>()
  const joins = new Map<string, string>()
  const requests: FakeColabApi["requests"] = [] as never
  const operations = new Map<string, { polls: number; runtimeId: string; error?: unknown; done: boolean }>()
  const failures: { method: string; path: RegExp; failure: FakeFailure; count: number }[] = []
  let operationSeq = 0
  let operationsWaited = 0
  const createPolls = options.createPolls ?? 0

  const api: Partial<FakeColabApi> & { proxyToken: string; tier: string } = {
    tier: "SUBSCRIPTION_TIER_PRO",
    proxyToken: options.runtimeToken ?? "proxy-token-1",
  }

  const urlOverrides = new Map<string, string>()
  const connectionFor = (runtimeId?: string): FakeRuntime["connection"] => ({
    url: (runtimeId ? urlOverrides.get(runtimeId) : undefined) ?? options.runtimeUrl,
    token: api.proxyToken,
    expireTime: new Date(Date.now() + 60 * 60_000).toISOString(),
  })

  const json = (response: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) => {
    const text = JSON.stringify(body)
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers })
    response.end(text)
  }

  const errorBody = (code: number, status: string, message: string, reason?: string) => ({
    error: { code, status, message, details: reason ? [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "colaboratory.googleapis.com" }] : [] },
  })

  const runtimeResource = (runtime: FakeRuntime) => ({
    name: `runtimes/${runtime.id}`,
    runtimeSpec: { variant: runtime.spec.variant, shape: runtime.spec.shape, accelerator: runtime.spec.accelerator },
    connectionInfo: runtime.connection,
  })

  const operationResource = (name: string, operation: { polls: number; runtimeId: string; error?: unknown; done: boolean }) => {
    const runtime = runtimes.get(operation.runtimeId)
    return {
      name,
      done: operation.done || operation.polls <= 0,
      ...(operation.error ? { error: operation.error } : {}),
      ...(!operation.error && (operation.done || operation.polls <= 0) && runtime ? { response: runtimeResource(runtime) } : {}),
    }
  }

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fake")
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      const method = request.method ?? "GET"
      const path = url.pathname.replace(/^\//, "")
      const authorization = request.headers.authorization
      requests.push({ method, path, query: url.search, body, ...(typeof authorization === "string" ? { authorization } : {}) })
      if (!authorization || !authorization.startsWith("Bearer ")) {
        return json(response, 401, errorBody(16, "UNAUTHENTICATED", "Request had invalid authentication credentials."))
      }
      const failure = failures.findIndex((entry) => entry.method === method && entry.path.test(path))
      if (failure !== -1) {
        const entry = failures[failure]!
        if (entry.count <= 1) failures.splice(failure, 1)
        else entry.count -= 1
        return json(response, entry.failure.status, entry.failure.body ?? errorBody(entry.failure.status, "FAILED", "injected failure"), entry.failure.headers ?? {})
      }
      if (path === "v1beta/runtimespecs" && method === "GET") {
        return json(response, 200, { runtimeSpecs: specs.map((spec) => ({ key: { variant: spec.variant, shape: spec.shape, accelerator: spec.accelerator }, eligible: spec.eligible })) })
      }
      if (path === "v1beta/subscription" && method === "GET") {
        return json(response, 200, { name: "subscription", tier: api.tier })
      }
      if (path === "v1beta/runtimes" && method === "GET") {
        return json(response, 200, { runtimes: [...runtimes.values()].map(runtimeResource) })
      }
      if (path === "v1beta/runtimes" && method === "POST") {
        const runtimeId = url.searchParams.get("runtimeId") ?? ""
        const requestId = url.searchParams.get("requestId") ?? ""
        let parsed: { runtimeSpec?: { variant?: string; shape?: string; accelerator?: string } } = {}
        try {
          parsed = JSON.parse(body || "{}") as typeof parsed
        } catch {
          return json(response, 400, errorBody(3, "INVALID_ARGUMENT", "bad body"))
        }
        const existing = runtimes.get(runtimeId)
        if (existing) {
          if (existing.requestId === requestId) {
            // A retried create joins the first: the same Operation, already done.
            const name = [...operations.entries()].find(([, operation]) => operation.runtimeId === runtimeId)?.[0] ?? `operations/${++operationSeq}`
            return json(response, 200, { name, done: true, response: runtimeResource(existing) })
          }
          const name = `operations/${++operationSeq}`
          return json(response, 200, { name, done: true, error: { code: 6, status: "ALREADY_EXISTS", message: "runtime already exists" } })
        }
        const spec = specs.find((entry) => entry.variant === parsed.runtimeSpec?.variant && entry.accelerator === parsed.runtimeSpec?.accelerator) ?? specs[0]!
        const runtime: FakeRuntime = { id: runtimeId, spec, requestId, connection: connectionFor(runtimeId) }
        runtimes.set(runtimeId, runtime)
        joins.set(requestId, runtimeId)
        const name = `operations/${++operationSeq}`
        operations.set(name, { polls: createPolls, runtimeId, done: createPolls === 0 })
        return json(response, 200, operationResource(name, operations.get(name)!))
      }
      const runtimeMatch = /^v1beta\/runtimes\/([^/]+)$/.exec(path)
      if (runtimeMatch && method === "GET") {
        const runtime = runtimes.get(decodeURIComponent(runtimeMatch[1]!))
        if (!runtime) return json(response, 404, errorBody(5, "NOT_FOUND", "runtime not found"))
        runtime.connection = connectionFor(runtime.id)
        return json(response, 200, runtimeResource(runtime))
      }
      if (runtimeMatch && method === "DELETE") {
        if (!runtimes.delete(decodeURIComponent(runtimeMatch[1]!))) return json(response, 404, errorBody(5, "NOT_FOUND", "runtime not found"))
        response.writeHead(200, { "content-type": "application/json" })
        return response.end("{}")
      }
      // `colaboratory.operations.wait` is a GET on v1/{+name}:wait with the timeout query (v1 discovery 20261116); any
      // other method on that path is refused here, so a client that sends a POST fails its tests.
      const waitPath = /^v1\/operations\/([^/:]+):wait$/.test(path)
      if (waitPath && method !== "GET") {
        return json(response, 405, errorBody(12, "UNIMPLEMENTED", "operations.wait is a GET"))
      }
      const waitMatch = /^v1\/operations\/([^/:]+):wait$/.exec(path)
      if (waitMatch && method === "GET") {
        const name = `operations/${waitMatch[1]}`
        const operation = operations.get(name)
        if (!operation) return json(response, 404, errorBody(5, "NOT_FOUND", "operation not found"))
        operationsWaited += 1
        if (!operation.done) {
          operation.polls -= 1
          if (operation.polls <= 0) operation.done = true
        }
        return json(response, 200, operationResource(name, operation))
      }
      const operationMatch = /^(?:v1beta\/|v1\/)?operations\/([^/]+)$/.exec(path)
      if (operationMatch && method === "GET") {
        const name = `operations/${operationMatch[1]}`
        const operation = operations.get(name)
        if (!operation) return json(response, 404, errorBody(5, "NOT_FOUND", "operation not found"))
        if (!operation.done) {
          operation.polls -= 1
          if (operation.polls <= 0) operation.done = true
        }
        return json(response, 200, operationResource(name, operation))
      }
      return json(response, 404, errorBody(5, "NOT_FOUND", "no such method"))
    })
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as AddressInfo

  const fake: FakeColabApi = {
    url: `http://127.0.0.1:${address.port}`,
    specs,
    get tier() {
      return api.tier
    },
    set tier(value: string) {
      api.tier = value
    },
    runtimes,
    joins,
    requests,
    get operationsWaited() {
      return operationsWaited
    },
    failNext(match, failure, count = 1) {
      failures.push({ ...match, failure, count })
    },
    get proxyToken() {
      return api.proxyToken
    },
    set proxyToken(value: string) {
      api.proxyToken = value
    },
    rotateProxyToken(next: string) {
      api.proxyToken = next
    },
    setRuntimeUrl(runtimeId: string, url: string) {
      urlOverrides.set(runtimeId, url)
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  void now
  return fake
}
