/**
 * The Colab API v1beta client (design §1, §16): runtimes, runtime specs, the subscription, and the create LRO with its
 * `requestId` join. Google's answers become the plugin's codes here and nowhere else.
 *
 * Every request goes to the service root named in the discovery module's API origin with the access token A hands out for the account's
 * access level; the shapes are the ones `src/runtime/discovery.ts` pins. 429 and 5xx are retried with jittered backoff
 * on idempotent calls only — reads, deletes, and a create carrying the plan's `requestId` (AIP-155) — and then answer
 * RATE_LIMITED (with `retryAfterSec`) or UNAVAILABLE. No message this file builds contains a token, a URL, or Google's
 * text unscrubbed.
 */
import { ColabError } from "../../domain/errors.js"
import type { PortEnv } from "../index.js"
import type { ColabApi, ColabRuntime, ConnectionInfo, RuntimeSpecKey, SubscriptionTier } from "../ports.js"
import { redact, shortReason } from "../../redact.js"
import { COLAB_API_ORIGIN, COLAB_API_PATHS, COLAB_DISCOVERY_REVISION, COLAB_OPERATION_PATHS, COLAB_OPERATION_WAIT_TIMEOUT, COLAB_READ_SCOPE, COLAB_SCOPE } from "./discovery.js"

/** The retry schedule for idempotent calls; a test passes zero delays. */
const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [400, 1_200]

export interface ColabApiOptions {
  readonly fetch?: typeof fetch
  readonly retryDelaysMs?: readonly number[]
  /** The LRO poll interval; a test uses 0. */
  readonly operationPollMs?: number
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ColabError("CANCELLED"))
    if (ms <= 0) return resolve()
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ColabError("CANCELLED"))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal.addEventListener("abort", onAbort, { once: true })
  })

/** `google.rpc.ErrorInfo.reason`, from a REST error or an Operation's `error.details`. */
function errorInfoReason(details: unknown): string | undefined {
  if (!Array.isArray(details)) return undefined
  for (const entry of details) {
    if (entry && typeof entry === "object" && typeof (entry as { reason?: unknown }).reason === "string") return (entry as { reason: string }).reason
  }
  return undefined
}

/**
 * The reason → code table for FAILED_PRECONDITION answers (capacity, compute units, runtime count; design §12, L5).
 * The reasons themselves are L5's to pin, so this reads the words Google's reasons are built from and falls back to
 * CAPACITY_UNAVAILABLE, whose meaning ("Google has no capacity for that spec now") is the safe one to be wrong about.
 */
export function codeForReason(reason: string | undefined): ColabError {
  const value = (reason ?? "").toUpperCase()
  if (/TOO_MANY|RUNTIME_LIMIT|LIMIT_REACHED|MAX_RUNTIME/.test(value)) return new ColabError("TOO_MANY_RUNTIMES")
  if (/USAGE|COMPUTE_UNIT|QUOTA|CREDIT|BILLING/.test(value)) return new ColabError("USAGE_LIMIT")
  if (/DISABLED|NOT_ENABLED|ACCESS_NOT_CONFIGURED|CONSUMER/.test(value)) return new ColabError("COLAB_API_UNAVAILABLE")
  return new ColabError("CAPACITY_UNAVAILABLE")
}

interface GoogleErrorBody {
  readonly code?: number
  readonly message?: string
  readonly status?: string
  readonly details?: unknown
}

/** Google's REST error, Operation error or gRPC status code as a `ColabError`. Never echoes a token or a URL. */
export function colabErrorFor(input: { readonly http?: number; readonly code?: number; readonly body?: GoogleErrorBody; readonly retryAfterSec?: number }): ColabError {
  const base = baseErrorFor(input)
  const reason = errorInfoReason(input.body?.details)
  const answer = shortReason(input.body?.message ?? "")
  const withReason = reason ? new ColabError(base.code, `${base.detail} Google gave the reason ${redact(reason)}.`, extrasOf(base)) : base
  return answer ? new ColabError(withReason.code, `${withReason.detail} Google's answer: ${redact(answer)}.`, extrasOf(withReason)) : withReason
}

const extrasOf = (error: ColabError) => ({ ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}) })

function baseErrorFor(input: { readonly http?: number; readonly code?: number; readonly body?: GoogleErrorBody; readonly retryAfterSec?: number }): ColabError {
  const reason = errorInfoReason(input.body?.details)
  const gRPC = input.code
  const http = input.http
  if (http === 401 || gRPC === 16) return new ColabError("AUTH_REQUIRED")
  if (http === 429 || gRPC === 8) return new ColabError("RATE_LIMITED", undefined, input.retryAfterSec !== undefined ? { retryAfterSec: input.retryAfterSec } : {})
  if (http === 403 || gRPC === 7) {
    // A 403 that says the API or the client project is not configured is L1's gate, not an IAM problem.
    if (/DISABLED|NOT_CONFIGURED|CONSUMER_INVALID|ACCESS_NOT_CONFIGURED/i.test(`${reason ?? ""} ${input.body?.status ?? ""}`)) return new ColabError("COLAB_API_UNAVAILABLE")
    return new ColabError("PERMISSION_DENIED")
  }
  if (http === 404 || gRPC === 5) return new ColabError("NOT_FOUND")
  if (http === 400 || http === 409 || http === 412 || gRPC === 9 || gRPC === 6) return codeForReason(reason)
  if (http === 408 || gRPC === 4 || (http !== undefined && http >= 500) || gRPC === 10 || gRPC === 13 || gRPC === 14) return new ColabError("UNAVAILABLE")
  return new ColabError("UNAVAILABLE")
}

interface OperationResource {
  readonly name?: string
  readonly done?: boolean
  readonly response?: Record<string, unknown>
  readonly error?: GoogleErrorBody
}

interface RuntimeResource {
  readonly name?: string
  readonly version?: string
  readonly runtimeSpec?: { readonly variant?: string; readonly shape?: string; readonly accelerator?: string }
  readonly connectionInfo?: { readonly url?: string; readonly token?: string; readonly expireTime?: string }
}

const specKey = (raw: RuntimeResource["runtimeSpec"]): RuntimeSpecKey => ({
  variant: (raw?.variant ?? "VARIANT_CPU") as RuntimeSpecKey["variant"],
  shape: (raw?.shape ?? "SHAPE_STANDARD") as RuntimeSpecKey["shape"],
  accelerator: raw?.accelerator ?? "NONE",
})

const runtimeOf = (raw: RuntimeResource): ColabRuntime => ({ name: raw.name ?? "", spec: specKey(raw.runtimeSpec), ...(raw.version ? { version: raw.version } : {}) })

const connectionOf = (raw: RuntimeResource): ConnectionInfo | undefined => {
  const info = raw.connectionInfo
  if (!info?.url || !info.token || !info.expireTime) return undefined
  return { url: info.url, token: info.token, expireTime: info.expireTime }
}

export function createColabApi(env: PortEnv, overrides: ColabApiOptions = {}): ColabApi {
  const doFetch = overrides.fetch ?? env.fetch
  const retryDelays = overrides.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS
  const pollMs = overrides.operationPollMs ?? 250

  const scopesFor = (account: string, write: boolean): readonly string[] => {
    const resolved = env.options.accounts.find((entry) => entry.alias === account)
    if (!resolved) throw new ColabError("ACCOUNT_UNKNOWN", `No account is named "${account}".`)
    if (write) return [COLAB_SCOPE]
    return resolved.access === "write" ? [COLAB_SCOPE] : [COLAB_READ_SCOPE]
  }

  async function send(account: string, request: { readonly method: "GET" | "POST" | "DELETE"; readonly path: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown; readonly write: boolean }, signal: AbortSignal) {
    if (signal.aborted) throw new ColabError("CANCELLED")
    const token = await env.auth.token(account, scopesFor(account, request.write), signal)
    const url = new URL(request.path, `${COLAB_API_ORIGIN}/`)
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.set(key, value)
    let response: Response
    try {
      response = await doFetch(url, {
        method: request.method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal,
        redirect: "error",
      })
    } catch (error) {
      if (signal.aborted) throw new ColabError("CANCELLED")
      if (error instanceof ColabError) throw error
      throw new ColabError("UNAVAILABLE")
    }
    const text = await response.text().catch(() => "")
    let parsed: unknown
    if (text !== "") {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = undefined
      }
    }
    if (response.ok) return { status: response.status, body: parsed }
    // Google's REST errors wrap the status in `error`; an Operation carries it directly.
    const failure = (parsed as { error?: GoogleErrorBody } | undefined)?.error ?? (parsed as GoogleErrorBody | undefined)
    const retryAfter = Number(response.headers.get("retry-after"))
    throw colabErrorFor({
      http: response.status,
      body: failure,
      ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSec: retryAfter } : {}),
    })
  }

  /** One request, retried on 429 and 5xx when `idempotent` allows it. */
  async function call(account: string, request: { readonly method: "GET" | "POST" | "DELETE"; readonly path: string; readonly query?: Readonly<Record<string, string>>; readonly body?: unknown; readonly write: boolean; readonly idempotent: boolean }, signal: AbortSignal) {
    const attempts = request.idempotent ? 1 + retryDelays.length : 1
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await send(account, request, signal)
      } catch (error) {
        const retryable = error instanceof ColabError && (error.code === "RATE_LIMITED" || error.code === "UNAVAILABLE")
        if (!retryable || attempt + 1 >= attempts || signal.aborted) throw error
        const base = retryDelays[attempt] ?? retryDelays.at(-1) ?? 0
        await sleep(Math.round(base * (0.5 + Math.random())), signal)
      }
    }
  }

  /**
   * A create's Operation is followed where the v1 discovery documents it: `colaboratory.operations.wait`, a **GET** on
   * `v1/operations/{id}:wait?timeout=…`, then `colaboratory.operations.get` (GET `v1/operations/{id}`), then the v1beta
   * path, so a create still completes if Google serves only one of them. The name the API returned is `operations/{id}`
   * (the version prefix stripped); L5 pins that shape.
   */
  const operationId = (name: string): string => {
    if (!/^(?:v1beta\/|v1\/)?operations\/[A-Za-z0-9_-]+$/.test(name)) throw new ColabError("UNAVAILABLE", "The Colab API's create answer named an operation this client cannot follow.")
    return name.replace(/^(?:v1beta\/|v1\/)?operations\//, "")
  }

  const readOperation = async (account: string, name: string, signal: AbortSignal): Promise<OperationResource> => {
    const id = operationId(name)
    try {
      const answer = await call(account, { method: "GET", path: `${COLAB_OPERATION_PATHS.wait}/${id}:wait`, query: { timeout: COLAB_OPERATION_WAIT_TIMEOUT }, write: false, idempotent: true }, signal)
      return (answer.body ?? {}) as OperationResource
    } catch (error) {
      if (!(error instanceof ColabError) || error.code !== "NOT_FOUND") throw error
    }
    try {
      const answer = await call(account, { method: "GET", path: `${COLAB_OPERATION_PATHS.get}/${id}`, write: false, idempotent: true }, signal)
      return (answer.body ?? {}) as OperationResource
    } catch (error) {
      if (!(error instanceof ColabError) || error.code !== "NOT_FOUND") throw error
    }
    const answer = await call(account, { method: "GET", path: `v1beta/operations/${id}`, write: false, idempotent: true }, signal)
    return (answer.body ?? {}) as OperationResource
  }

  const api: ColabApi = {
    async listRuntimeSpecs(account, signal) {
      const answer = await call(account, { method: "GET", path: COLAB_API_PATHS.runtimeSpecs, write: false, idempotent: true }, signal)
      const list = (answer.body as { runtimeSpecs?: { key?: RuntimeResource["runtimeSpec"]; eligible?: boolean }[] } | undefined)?.runtimeSpecs ?? []
      return list.map((entry) => ({ key: specKey(entry.key), eligible: entry.eligible === true }))
    },

    async getSubscription(account, signal) {
      const answer = await call(account, { method: "GET", path: COLAB_API_PATHS.subscription, write: false, idempotent: true }, signal)
      const tier = (answer.body as { tier?: string } | undefined)?.tier
      return (tier ?? "SUBSCRIPTION_TIER_UNSPECIFIED") as SubscriptionTier
    },

    async listRuntimes(account, signal) {
      const answer = await call(account, { method: "GET", path: COLAB_API_PATHS.runtimes, write: false, idempotent: true }, signal)
      const list = (answer.body as { runtimes?: RuntimeResource[] } | undefined)?.runtimes ?? []
      return list.map(runtimeOf)
    },

    async getRuntime(account, runtimeId, signal) {
      try {
        const answer = await call(account, { method: "GET", path: `${COLAB_API_PATHS.runtimes}/${encodeURIComponent(runtimeId)}`, write: false, idempotent: true }, signal)
        const raw = (answer.body ?? {}) as RuntimeResource
        const connection = connectionOf(raw)
        return { runtime: runtimeOf(raw), ...(connection ? { connection } : {}) }
      } catch (error) {
        // A runtime that ended answers 404; design §9.5 gives it its own code.
        if (error instanceof ColabError && error.code === "NOT_FOUND") throw new ColabError("RUNTIME_GONE")
        throw error
      }
    },

    async createRuntime(account, input, signal) {
      const started = env.clock.now().getTime()
      // A create is idempotent only because of `requestId` (AIP-155), so a retry joins the first create.
      const answer = await call(
        account,
        {
          method: "POST",
          path: COLAB_API_PATHS.runtimes,
          query: { runtimeId: input.runtimeId, requestId: input.requestId },
          body: { runtimeSpec: input.spec },
          write: true,
          idempotent: true,
        },
        signal,
      )
      let operation = (answer.body ?? {}) as OperationResource
      const name = operation.name ?? ""
      for (;;) {
        if (operation.error) {
          // A client-chosen id that already exists is a join, not a failure (discovery: ALREADY_EXISTS, code 6).
          if (operation.error.code === 6) {
            const existing = await api.getRuntime(account, input.runtimeId, signal)
            if (!existing) throw new ColabError("RUNTIME_GONE")
            return { done: true, runtime: existing.runtime, operation: name }
          }
          throw colabErrorFor({ code: operation.error.code, body: operation.error })
        }
        if (operation.done) {
          const joined = operation.response ? undefined : await api.getRuntime(account, input.runtimeId, signal)
          if (!operation.response && !joined) throw new ColabError("RUNTIME_GONE")
          const runtime = operation.response ? runtimeOf(operation.response as RuntimeResource) : joined!.runtime
          return { done: true, runtime, operation: name }
        }
        if (env.clock.now().getTime() - started >= input.waitMs) return { done: false, operation: name }
        await sleep(pollMs, signal)
        operation = await readOperation(account, name, signal)
      }
    },

    async deleteRuntime(account, runtimeId, signal) {
      await call(account, { method: "DELETE", path: `${COLAB_API_PATHS.runtimes}/${encodeURIComponent(runtimeId)}`, write: true, idempotent: true }, signal)
    },
  }
  return api
}

/** The discovery revision this client is written against; the drift workflow compares it with the live one. */
export const PINNED_DISCOVERY_REVISION = COLAB_DISCOVERY_REVISION
