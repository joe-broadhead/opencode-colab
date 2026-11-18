/**
 * The one HTTP path to Google for package E: `fetch` with a bearer token, the API's JSON error envelope mapped to the
 * plugin's codes, and retries only where a retry is safe (design §9.4: "429/RESOURCE_EXHAUSTED retried with jittered
 * backoff on idempotent calls only, then RATE_LIMITED").
 *
 * A create is never retried here: a job create is idempotent through its client-chosen `notebookExecutionJobId` and is
 * joined on `ALREADY_EXISTS`, and a schedule create has no id and is reconciled by its display-name token (§7.2), so
 * both are the caller's decision, not a transport retry.
 *
 * The error envelope is Google's (`{ "error": { "code", "message", "status", "details": [{ "reason" }] } }`, API
 * Design Guide, errors; https://cloud.google.com/apis/design/errors). Google's message is redacted and cut before it
 * reaches a code's message, and never becomes a `next` step (design §7.3).
 */
import { ColabError, type ErrorCode } from "../domain/errors.js"
import { cut, redact } from "../redact.js"

export interface RetryPolicy {
  /** Attempts in total; 1 means no retry. */
  readonly attempts: number
  /** The base delay; the retry delay is `base × 2^attempt` and the test passes 0. */
  readonly baseDelayMs: number
}

export const READ_RETRIES: RetryPolicy = { attempts: 3, baseDelayMs: 300 }

/** A non-2xx answer, or a network failure (status 0), before it becomes a plugin code. */
export class GoogleHttpError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string | undefined,
    readonly detail: string,
    readonly retryAfterSec?: number,
  ) {
    super(detail)
    this.name = "GoogleHttpError"
  }
}

/** A status worth retrying: a network failure, a timeout (0), quota (429) or a server fault. */
export const retryableStatus = (status: number) => status === 0 || status === 429 || status >= 500

export interface GoogleCall {
  readonly fetch: typeof fetch
  readonly url: string
  readonly method: "GET" | "POST" | "PATCH" | "DELETE"
  readonly token: string
  readonly signal: AbortSignal
  readonly body?: unknown
  readonly retry: RetryPolicy
}

export async function googleJson<T = Record<string, unknown>>(call: GoogleCall): Promise<T> {
  let last: GoogleHttpError | undefined
  for (let attempt = 0; attempt < call.retry.attempts; attempt += 1) {
    if (attempt > 0) await sleep(call.retry.baseDelayMs * 2 ** (attempt - 1), call.signal)
    try {
      const response = await call.fetch(call.url, {
        method: call.method,
        headers: {
          authorization: `Bearer ${call.token}`,
          accept: "application/json",
          ...(call.body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
        signal: call.signal,
      })
      if (response.ok) {
        if (response.status === 204) return {} as T
        const text = await response.text()
        return (text.trim() === "" ? {} : JSON.parse(text)) as T
      }
      const text = await response.text().catch(() => "")
      const envelope = envelopeOf(text)
      last = new GoogleHttpError(response.status, envelope.reason, envelope.detail, envelope.retryAfterSec ?? retryAfterOf(response.headers.get("retry-after")))
      if (!retryableStatus(response.status) || attempt === call.retry.attempts - 1) throw last
    } catch (error) {
      if (error instanceof GoogleHttpError) throw error
      if (error instanceof Error && error.name === "AbortError") throw error
      last = new GoogleHttpError(0, "NETWORK", error instanceof Error ? error.message : String(error))
      if (attempt === call.retry.attempts - 1) throw last
    }
  }
  throw last ?? new GoogleHttpError(0, "NETWORK", "The request did not run.")
}

interface Envelope {
  readonly reason: string | undefined
  readonly detail: string
  readonly retryAfterSec?: number
}

function envelopeOf(text: string): Envelope {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown; status?: unknown; details?: unknown } }
    const error = parsed.error
    const details = Array.isArray(error?.details) ? (error!.details as { reason?: unknown; retryDelay?: unknown }[]) : []
    const reason = details.find((detail) => typeof detail?.reason === "string")?.reason ?? (typeof error?.status === "string" ? error.status : undefined)
    const retryDelay = details.find((detail) => typeof detail?.retryDelay === "string")?.retryDelay
    const problem = error?.message
    const detail = cut(redact(typeof problem === "string" ? problem : typeof error?.status === "string" ? error.status : "Google refused the call."), 200)
    const seconds = typeof retryDelay === "string" ? /^(\d+(?:\.\d+)?)s$/.exec(retryDelay)?.[1] : undefined
    return { reason: typeof reason === "string" ? reason : undefined, detail, ...(seconds !== undefined ? { retryAfterSec: Math.ceil(Number(seconds)) } : {}) }
  } catch {
    const detail = cut(redact(text.trim() === "" ? "Google refused the call." : text), 200)
    return { reason: undefined, detail }
  }
}

function retryAfterOf(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1000)) : undefined
}

/** A Google failure as the plugin's code, with the specific next step the caller gives. */
export function googleError(error: unknown, next?: string): ColabError {
  if (error instanceof ColabError) return error
  if (error instanceof Error && error.name === "AbortError") return new ColabError("CANCELLED")
  const http = error instanceof GoogleHttpError ? error : new GoogleHttpError(0, "NETWORK", error instanceof Error ? error.message : String(error))
  const detail = cut(redact(http.detail), 200)
  const code = codeOf(http)
  return new ColabError(code, `Google refused the call: ${detail}`, {
    ...(next !== undefined ? { next } : {}),
    ...(code === "RATE_LIMITED" && http.retryAfterSec !== undefined ? { retryAfterSec: http.retryAfterSec } : {}),
    ...(http.reason !== undefined && code === "AUTH_REQUIRED" ? { reason: http.reason } : {}),
  })
}

function codeOf(http: GoogleHttpError): ErrorCode {
  if (http.status === 401) return "AUTH_REQUIRED"
  if (http.status === 403) {
    // A 403 whose ErrorInfo reason ends in DISABLED names an API or billing problem, not IAM (API Design Guide, errors);
    // an insufficient access-token scope is the sign-in's scope, not an IAM grant.
    if (http.reason !== undefined && /_DISABLED$/.test(http.reason)) return "API_DISABLED"
    if (http.reason !== undefined && /_SCOPE_INSUFFICIENT$/.test(http.reason)) return "AUTH_SCOPE_MISSING"
    return "PERMISSION_DENIED"
  }
  if (http.status === 404) return "NOT_FOUND"
  if (http.status === 429) return "RATE_LIMITED"
  if (http.status === 400 || http.status === 409) return "INPUT_INVALID"
  return "UNAVAILABLE"
}

/** A sleep the abort signal can cut short. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new ColabError("CANCELLED"))
    }
    if (signal.aborted) return onAbort()
    signal.addEventListener("abort", onAbort, { once: true })
  })
}
