/**
 * The Cloud Storage JSON API client package E owns: list a bucket prefix and read an object, for an Enterprise job's
 * result notebook (design §6 `colab_execution`, §9.3 capture).
 *
 * Shapes are Google's Cloud Storage JSON API v1, fetched 2026-11-17:
 * - `GET /storage/v1/b/{bucket}/o?prefix=&maxResults=&pageToken=` → `{ items: [{ name, size, updated }],
 *   nextPageToken }`; https://cloud.google.com/storage/docs/json_api/v1/objects/list
 * - `GET /storage/v1/b/{bucket}/o/{object}?alt=media` → the bytes; object names are URL-encoded, slashes included.
 *   https://cloud.google.com/storage/docs/json_api/v1/objects/get
 *
 * The job's `gcsOutputUri` names a bucket only ("Format: gs://bucket-name", Vertex v1 discovery 20261107); where a run
 * writes its output notebook inside that bucket is not documented. L10 records the layout; until then capture lists the
 * bucket for `.ipynb` objects written at or after the job's create time (src/enterprise/capture.ts, TODO(L10)).
 */
import type { PortEnv } from "../deps.js"
import { ColabError } from "../domain/errors.js"
import type { GcsApi } from "../ports.js"
import { ENTERPRISE_SCOPES } from "./account.js"
import { GoogleHttpError, googleError, READ_RETRIES, sleep, type RetryPolicy } from "./http.js"
import { gcsParts } from "./ids.js"

export interface GcsOptions {
  readonly baseUrl?: string
  readonly retryDelayMs?: number
}

const DEFAULT_BASE = "https://storage.googleapis.com/storage/v1/"

export function createGcs(env: PortEnv, options: GcsOptions = {}): GcsApi {
  const base = options.baseUrl ?? DEFAULT_BASE
  const retry: RetryPolicy = { ...READ_RETRIES, baseDelayMs: options.retryDelayMs ?? READ_RETRIES.baseDelayMs }

  async function call(account: string, path: string, signal: AbortSignal): Promise<Response> {
    const token = await env.auth.token(account, ENTERPRISE_SCOPES, signal)
    try {
      return await fetchRetrying(env.fetch, `${base}${path}`, token, signal, retry)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      throw googleError(error)
    }
  }

  return {
    async list(account, prefix, signal) {
      const { bucket, prefix: path } = gcsParts(prefix)
      const found: { uri: string; size: number; updated?: string }[] = []
      let pageToken: string | undefined
      for (let page = 0; page < 10; page += 1) {
        const query = new URLSearchParams({ maxResults: "1000", fields: "items(name,size,updated),nextPageToken" })
        if (path !== "") query.set("prefix", path)
        if (pageToken) query.set("pageToken", pageToken)
        const response = await call(account, `b/${encodeURIComponent(bucket)}/o?${query.toString()}`, signal)
        const body = (await response.json()) as { items?: { name?: unknown; size?: unknown; updated?: unknown }[]; nextPageToken?: unknown }
        for (const item of body.items ?? []) {
          if (typeof item.name !== "string") continue
          found.push({
            uri: `gs://${bucket}/${item.name}`,
            size: typeof item.size === "number" ? item.size : Number(item.size ?? 0),
            ...(typeof item.updated === "string" ? { updated: item.updated } : {}),
          })
        }
        pageToken = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined
        if (!pageToken) break
      }
      return found
    },

    async read(account, uri, signal) {
      const { bucket } = gcsParts(uri)
      const object = uri.slice(`gs://${bucket}/`.length)
      if (object === "") throw googleError(new GoogleHttpError(400, undefined, "A bucket is not an object."))
      const response = await call(account, `b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(object)}?alt=media`, signal)
      // A cap at the transport, not after the whole object is in memory (review LOW 2): a declared size over the cap
      // is refused before the body is read, and a stream is cut as soon as it passes the cap.
      const limit = env.options.maxDownloadBytes
      const declared = Number(response.headers.get("content-length"))
      if (Number.isFinite(declared) && declared > limit) {
        await response.body?.cancel()
        throw new ColabError("FILE_TOO_LARGE", `The object is ${declared} bytes, over maxDownloadBytes (${limit}).`, { next: "Raise maxDownloadBytes, or read the object another way." })
      }
      if (!response.body) return new Uint8Array(await response.arrayBuffer())
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.length
        if (total > limit) {
          await reader.cancel().catch(() => undefined)
          throw new ColabError("FILE_TOO_LARGE", `The object is over maxDownloadBytes (${limit}).`, { next: "Raise maxDownloadBytes, or read the object another way." })
        }
        chunks.push(value)
      }
      const bytes = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      return bytes
    },
  }
}

/** A GET that retries 429 and 5xx with backoff and returns the successful response; failures stay Google-shaped. */
async function fetchRetrying(fetchImpl: typeof fetch, url: string, token: string, signal: AbortSignal, retry: RetryPolicy): Promise<Response> {
  for (let attempt = 0; attempt < retry.attempts; attempt += 1) {
    if (attempt > 0) await sleep(retry.baseDelayMs * 2 ** (attempt - 1), signal)
    let response: Response
    try {
      response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${token}` }, signal })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      if (attempt === retry.attempts - 1) throw new GoogleHttpError(0, "NETWORK", error instanceof Error ? error.message : String(error))
      continue
    }
    if (response.ok) return response
    const text = await response.text().catch(() => "")
    if (!(response.status === 429 || response.status >= 500) || attempt === retry.attempts - 1) throw new GoogleHttpError(response.status, undefined, text === "" ? `HTTP ${response.status}` : text)
  }
  throw new GoogleHttpError(0, "NETWORK", "The request did not run.")
}
