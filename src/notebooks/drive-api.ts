/**
 * Drive API v3 over `fetch` (design D2, Q5): `files.list`, `files.get` (`alt=media` for content), `files.create`,
 * `files.update`, `files.generateIds`, `revisions.update` (`keepForever`) and `revisions.list` (the kept count), with
 * the one scope `drive.file` — the plugin reaches only notebooks it created or was given.
 *
 * Shapes, from Google's Drive API v3 reference and guides:
 * - `files.list`: `q`, `pageSize` (at most 1000), `spaces`, `fields`; it returns trashed files unless asked otherwise
 *   (reference/rest/v3/files/list).
 * - `files.get` with `alt=media` returns the file's bytes (reference/rest/v3/files/get; guides/manage-downloads).
 * - `files.create` takes an `/upload` URI; a multipart upload carries the metadata and the bytes in one request, and is
 *   for "a small file (5 MB or less)", while a resumable upload is "for large files (greater than 5 MB)"
 *   (guides/manage-uploads; reference/rest/v3/files/create).
 * - `files.generateIds` pre-generates a file id: "You can safely retry uploads with pre-generated IDs … If the file
 *   action is successful, subsequent retries return a 409 Conflict … and duplicate files aren't created"
 *   (guides/manage-uploads; reference/rest/v3/files/generateIds). This client retries a failed create with the same id
 *   and joins a 409 by reading the file back.
 * - `files.update` with `uploadType=media` replaces a file's bytes, a resumable `PATCH` does so above 5 MB, and a
 *   `trashed: true` patch moves it to the trash (reference/rest/v3/files/update; guides/delete).
 * - `revisions.update` is `PATCH /files/{fileId}/revisions/{revisionId}`; `keepForever` "can be set on a maximum of
 *   200 revisions for a file" (reference/rest/v3/revisions/update; guides/manage-revisions). `revisions.list` reports
 *   which are kept (reference/rest/v3/revisions/list).
 *
 * Errors use Drive's documented reasons (`notFound`, `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`,
 * `storageQuotaExceeded`, `domainPolicy`, `accessNotConfigured`, `insufficientPermissions`; guides/handle-errors) and map
 * to the plugin's codes. A message contains only the plugin's words and the HTTP status and reason, never Google's
 * message, a token, a file name or the resumable session URI (a credential, like the access token).
 */
import { randomUUID } from "node:crypto"
import { ColabError } from "../domain/errors.js"
import type { PortEnv } from "../deps.js"
import type { DriveApi, DriveFile } from "../ports.js"
import { DRIVE_SCOPE } from "./account.js"

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>

const API = "https://www.googleapis.com/drive/v3"
const UPLOAD = "https://www.googleapis.com/upload/drive/v3"
/** The file fields the port needs, asked for by name so Drive returns no more than that. */
const FIELDS = "id,name,mimeType,headRevisionId,modifiedTime,ownedByMe,lastModifyingUser(emailAddress)"
const TIMEOUT_MS = 60_000
const RETRY_DELAYS_MS = [200, 600]
/** Google's documented boundary between multipart/simple and resumable uploads (guides/manage-uploads). */
const SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024
const CREATE_RETRIES = 2
const RESUMABLE_ATTEMPTS = 5
/** A whole-body PUT of up to maxUploadBytes may take longer than an API call. */
const UPLOAD_TIMEOUT_MS = 300_000
const ENABLE_DRIVE = "https://console.cloud.google.com/apis/library/drive.googleapis.com"
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"])
const DISABLED_REASONS = new Set(["accessNotConfigured", "serviceDisabled"])
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"])

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const retryable = (status: number) => status === 429 || status >= 500
const jitter = () => Math.floor(Math.random() * 50)

/** A create attempt that may be repeated with the same pre-generated id. */
class RetryableUpload extends Error {}

interface DriveErrorBody {
  readonly error?: {
    readonly code?: number
    readonly status?: string
    readonly message?: string
    readonly errors?: readonly { readonly reason?: string }[]
    readonly details?: readonly { readonly reason?: string }[]
  }
}

function reasonOf(body: DriveErrorBody | undefined): string | undefined {
  const fromList = body?.error?.errors?.find((entry) => typeof entry.reason === "string")?.reason
  if (fromList) return fromList
  return body?.error?.details?.find((entry) => typeof entry.reason === "string")?.reason
}

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after")
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2_000) : fallback
}

const rateExtras = (response: Response): { readonly retryAfterSec?: number } => {
  const header = response.headers.get("retry-after")
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSec: Math.ceil(seconds) } : {}
}

function tooLarge(bytes: number, maxBytes: number): ColabError {
  return new ColabError("FILE_TOO_LARGE", `The notebook is ${bytes} bytes, over the plugin's ${maxBytes}-byte upload cap.`, {
    next: "Strip the outputs, split the notebook, or raise maxUploadBytes.",
  })
}

/** The plugin's code for one Drive answer. Google's own message is never copied into it. */
async function failureOf(response: Response): Promise<ColabError> {
  const text = await response.text().catch(() => "")
  let body: DriveErrorBody | undefined
  try {
    body = JSON.parse(text) as DriveErrorBody
  } catch {
    body = undefined
  }
  const reason = reasonOf(body)
  const detail = `Drive refused the call (HTTP ${response.status}${reason ? `, ${reason}` : ""}).`
  if (response.status === 401) return new ColabError("AUTH_REQUIRED", detail)
  if ((response.status === 403 || response.status === 401) && reason !== undefined && SCOPE_REASONS.has(reason)) {
    return new ColabError("AUTH_SCOPE_MISSING", detail, { next: "Sign in again at Read and write, and approve the Drive scope." })
  }
  if (response.status === 403 && reason !== undefined && RATE_REASONS.has(reason)) return new ColabError("RATE_LIMITED", detail, rateExtras(response))
  if (response.status === 403 && reason !== undefined && DISABLED_REASONS.has(reason)) {
    return new ColabError("API_DISABLED", detail, { next: `Enable the Drive API in the project: ${ENABLE_DRIVE}.` })
  }
  if (response.status === 403 && reason === "domainPolicy") {
    return new ColabError("PERMISSION_DENIED", detail, { next: "Ask the Workspace admin to allow this OAuth client (docs/auth.md)." })
  }
  if (response.status === 403 && reason === "storageQuotaExceeded") {
    return new ColabError("PERMISSION_DENIED", detail, { next: "Free space in the account's Drive, or push with another account." })
  }
  if (response.status === 403) return new ColabError("PERMISSION_DENIED", detail)
  if (response.status === 404) return new ColabError("NOT_FOUND", detail)
  if (response.status === 400) return new ColabError("INPUT_INVALID", detail, { next: "Check the Drive folder id and the notebook's name, then try again." })
  if (response.status === 429) return new ColabError("RATE_LIMITED", detail, rateExtras(response))
  return new ColabError("UNAVAILABLE", detail)
}

/** A file as the port wants it, from Drive's JSON. */
function imageOf(value: unknown): DriveFile {
  const json = value as Record<string, unknown>
  const id = json.id
  if (typeof id !== "string" || id.length === 0) throw new ColabError("UNAVAILABLE", "Drive's answer had no file id.")
  const modifier = json.lastModifyingUser as { readonly emailAddress?: unknown } | undefined
  return {
    id,
    name: typeof json.name === "string" ? json.name : "notebook",
    mimeType: typeof json.mimeType === "string" ? json.mimeType : "",
    ...(typeof json.headRevisionId === "string" ? { headRevisionId: json.headRevisionId } : {}),
    ...(typeof json.modifiedTime === "string" ? { modifiedTime: json.modifiedTime } : {}),
    ...(typeof json.ownedByMe === "boolean" ? { ownedByMe: json.ownedByMe } : {}),
    ...(typeof modifier?.emailAddress === "string" ? { lastModifyingUser: modifier.emailAddress } : {}),
  }
}

/** The next byte a 308's `Range: bytes=0-123` says to send; 0 when Drive did not say. */
function nextOffset(response: Response, total: number): number {
  const header = response.headers.get("range")
  const match = header === null ? null : /bytes=(\d+)-(\d+)/.exec(header)
  if (!match) return 0
  return Math.min(total, Number(match[2]) + 1)
}

export class HttpDriveApi implements DriveApi {
  constructor(private readonly env: PortEnv) {}

  private async token(account: string, signal: AbortSignal): Promise<string> {
    return this.env.auth.token(account, [DRIVE_SCOPE], signal)
  }

  /** One authenticated request: the caller decides what a non-2xx means. The token never reaches an error. */
  private async raw(account: string, url: string, init: FetchInit, signal: AbortSignal, timeoutMs = TIMEOUT_MS): Promise<Response> {
    const token = await this.token(account, signal)
    try {
      return await this.env.fetch(url, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      if (error instanceof Error && error.name === "TimeoutError") throw new ColabError("UNAVAILABLE", "The request to Drive timed out.")
      throw new ColabError("UNAVAILABLE", "The request to Drive did not complete.")
    }
  }

  /** A read with jittered retries on 429 and 5xx (design §9.4); the caller gets a 2xx or a ColabError. */
  private async send(account: string, url: string, init: FetchInit, signal: AbortSignal, retry: boolean): Promise<Response> {
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await this.raw(account, url, init, signal)
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        if (retry && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]! + jitter())
          continue
        }
        throw error
      }
      if (response.ok) return response
      if (!retry || !retryable(response.status) || attempt >= RETRY_DELAYS_MS.length) throw await failureOf(response)
      const wait = retryAfterMs(response, RETRY_DELAYS_MS[attempt]!)
      await response.body?.cancel().catch(() => undefined)
      await sleep(wait + jitter())
    }
  }

  async list(account: string, input: { readonly query?: string; readonly pageSize?: number }, signal: AbortSignal): Promise<readonly DriveFile[]> {
    const url = new URL(`${API}/files`)
    if (input.query !== undefined) url.searchParams.set("q", input.query)
    if (input.pageSize !== undefined) url.searchParams.set("pageSize", String(input.pageSize))
    url.searchParams.set("spaces", "drive")
    url.searchParams.set("fields", `files(${FIELDS})`)
    const response = await this.send(account, url.toString(), { method: "GET" }, signal, true)
    const body = (await response.json().catch(() => ({}))) as { readonly files?: readonly unknown[] }
    return Array.isArray(body.files) ? body.files.map(imageOf) : []
  }

  async get(account: string, fileId: string, signal: AbortSignal): Promise<DriveFile | undefined> {
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    try {
      const response = await this.send(account, url.toString(), { method: "GET" }, signal, true)
      return imageOf(await response.json())
    } catch (error) {
      if (ColabError.is(error) && error.code === "NOT_FOUND") return undefined
      throw error
    }
  }

  async download(account: string, fileId: string, signal: AbortSignal): Promise<Uint8Array> {
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set("alt", "media")
    url.searchParams.set("supportsAllDrives", "true")
    const response = await this.send(account, url.toString(), { method: "GET" }, signal, true)
    return new Uint8Array(await response.arrayBuffer())
  }

  /** A fresh id from `files.generateIds`, so a create may be retried without making a duplicate (guides/manage-uploads). */
  async generateId(account: string, signal: AbortSignal): Promise<string> {
    const url = new URL(`${API}/files/generateIds`)
    url.searchParams.set("count", "1")
    url.searchParams.set("space", "drive")
    url.searchParams.set("type", "files")
    const response = await this.send(account, url.toString(), { method: "GET" }, signal, true)
    const body = (await response.json().catch(() => ({}))) as { readonly ids?: readonly unknown[] }
    const id = Array.isArray(body.ids) ? body.ids[0] : undefined
    if (typeof id !== "string" || id.length === 0) throw new ColabError("UNAVAILABLE", "Drive did not return a file id.")
    return id
  }

  async create(account: string, input: { readonly id?: string; readonly name: string; readonly folder?: string; readonly bytes: Uint8Array; readonly mimeType: string }, signal: AbortSignal): Promise<DriveFile> {
    if (input.bytes.length > this.env.options.maxUploadBytes) throw tooLarge(input.bytes.length, this.env.options.maxUploadBytes)
    const id = input.id ?? (await this.generateId(account, signal))
    const metadata = { id, name: input.name, mimeType: input.mimeType, ...(input.folder !== undefined ? { parents: [input.folder] } : {}) }
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.createOnce(account, input, metadata, signal)
      } catch (error) {
        if (signal.aborted) return await this.joinAfterAbort(account, id, input.name)
        const repeatable = error instanceof RetryableUpload || (ColabError.is(error) && (error.code === "UNAVAILABLE" || error.code === "RATE_LIMITED"))
        if (!repeatable || attempt >= CREATE_RETRIES) {
          if (error instanceof RetryableUpload) throw new ColabError("UNAVAILABLE", "Drive's upload did not complete.", { next: 'Retry the plan; colab_find({ where: "drive" }) tells you whether the file arrived.' })
          throw error
        }
        await sleep(RETRY_DELAYS_MS[attempt]! + jitter())
      }
    }
  }

  private async createOnce(account: string, input: { readonly name: string; readonly bytes: Uint8Array; readonly mimeType: string }, metadata: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<DriveFile> {
    const response = input.bytes.length <= SIMPLE_UPLOAD_MAX
      ? await this.multipart(account, metadata, input.bytes, input.mimeType, signal)
      : await this.resumable(account, `${UPLOAD}/files`, "POST", metadata, input.bytes, input.mimeType, signal)
    if (response.ok) return imageOf(await response.json())
    await response.body?.cancel().catch(() => undefined)
    if (response.status === 409) return this.joinExisting(account, String(metadata.id), input.name, signal)
    if (retryable(response.status)) throw new RetryableUpload()
    throw await failureOf(response)
  }

  /** A 409: the pre-generated id already exists. Join it only when it is the notebook this push meant to create. */
  private async joinExisting(account: string, id: string, name: string, signal: AbortSignal): Promise<DriveFile> {
    const file = await this.get(account, id, signal)
    if (file && file.name === name) return file
    throw new ColabError("UNCERTAIN", "Drive said the pre-generated file id already exists, and that file does not match this push.", {
      next: 'colab_find({ where: "drive" }) lists the notebooks the plugin may see.',
    })
  }

  /** After a Stop, one short read with a fresh signal, so a create Drive already made is joined, not repeated. */
  private async joinAfterAbort(account: string, id: string, name: string): Promise<DriveFile> {
    const file = await this.get(account, id, AbortSignal.timeout(5_000)).catch(() => undefined)
    if (file && file.name === name) return file
    throw new ColabError("CANCELLED", "The call stopped before Drive's answer to the upload arrived.")
  }

  private async multipart(account: string, metadata: Readonly<Record<string, unknown>>, bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<Response> {
    const boundary = `oc-${randomUUID()}`
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify(metadata), "utf8"),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
      Buffer.from(bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const url = new URL(`${UPLOAD}/files`)
    url.searchParams.set("uploadType", "multipart")
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    return this.raw(account, url.toString(), { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, signal)
  }

  /**
   * A resumable upload (guides/manage-uploads): initiate with the metadata, keep the `Location` as a credential, PUT the
   * bytes, and on a 5xx, a network failure or a 308 query the session with `Content-Range: bytes *\/N` and send the rest.
   */
  private async resumable(account: string, endpoint: string, method: "POST" | "PATCH", metadata: Readonly<Record<string, unknown>>, bytes: Uint8Array, mimeType: string, signal: AbortSignal): Promise<Response> {
    const url = new URL(endpoint)
    url.searchParams.set("uploadType", "resumable")
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    const initiated = await this.raw(account, url.toString(), {
      method,
      headers: { "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Type": mimeType, "X-Upload-Content-Length": String(bytes.length) },
      body: JSON.stringify(metadata),
    }, signal)
    const location = initiated.headers.get("location")
    if (!initiated.ok || location === null) {
      await initiated.body?.cancel().catch(() => undefined)
      if (initiated.status === 409) return initiated
      if (retryable(initiated.status)) throw new RetryableUpload()
      throw await failureOf(initiated)
    }
    await initiated.body?.cancel().catch(() => undefined)

    let offset = 0
    for (let attempt = 0; attempt < RESUMABLE_ATTEMPTS; attempt += 1) {
      const response = offset === 0
        ? await this.raw(account, location, { method: "PUT", headers: { "Content-Type": mimeType, "Content-Length": String(bytes.length) }, body: Buffer.from(bytes) }, signal, UPLOAD_TIMEOUT_MS)
        : await this.raw(account, location, { method: "PUT", headers: { "Content-Type": mimeType, "Content-Range": `bytes ${offset}-${bytes.length - 1}/${bytes.length}` }, body: Buffer.from(bytes.subarray(offset)) }, signal, UPLOAD_TIMEOUT_MS)
      if (response.ok) return response
      if (response.status === 308) {
        offset = nextOffset(response, bytes.length)
        await response.body?.cancel().catch(() => undefined)
        continue
      }
      await response.body?.cancel().catch(() => undefined)
      if (!retryable(response.status)) {
        if (response.status === 409) return new Response("", { status: 409 })
        throw await failureOf(response)
      }
      // A 5xx or a lost answer: ask the session what it has, then send the rest.
      const status = await this.querySession(account, location, bytes.length, signal)
      if (status.file) return status.response
      offset = status.offset
    }
    throw new ColabError("UNAVAILABLE", "Drive's resumable upload did not finish.", { next: "Make the same call again; the pre-generated id joins a file Drive already made." })
  }

  /** `PUT` with `Content-Range: bytes *\/N`: 308 gives the next offset, 2xx gives the finished file. */
  private async querySession(account: string, location: string, total: number, signal: AbortSignal): Promise<{ readonly file: true; readonly response: Response } | { readonly file: false; readonly offset: number }> {
    const response = await this.raw(account, location, { method: "PUT", headers: { "Content-Range": `bytes */${total}` } }, signal).catch(() => undefined)
    if (!response) return { file: false, offset: 0 }
    if (response.ok) return { file: true, response }
    if (response.status === 308) {
      const offset = nextOffset(response, total)
      await response.body?.cancel().catch(() => undefined)
      return { file: false, offset }
    }
    await response.body?.cancel().catch(() => undefined)
    return { file: false, offset: 0 }
  }

  async update(account: string, fileId: string, input: { readonly bytes?: Uint8Array; readonly trashed?: boolean }, signal: AbortSignal): Promise<DriveFile> {
    if (input.bytes === undefined && input.trashed === undefined) throw new ColabError("INPUT_INVALID", "A Drive update needs bytes or trashed.")
    if (input.bytes !== undefined) {
      if (input.bytes.length > this.env.options.maxUploadBytes) throw tooLarge(input.bytes.length, this.env.options.maxUploadBytes)
      if (input.bytes.length <= SIMPLE_UPLOAD_MAX) {
        const url = new URL(`${UPLOAD}/files/${encodeURIComponent(fileId)}`)
        url.searchParams.set("uploadType", "media")
        url.searchParams.set("fields", FIELDS)
        url.searchParams.set("supportsAllDrives", "true")
        const response = await this.send(account, url.toString(), { method: "PATCH", headers: { "Content-Type": "application/vnd.google.colaboratory" }, body: Buffer.from(input.bytes) }, signal, false)
        return imageOf(await response.json())
      }
      const response = await this.resumable(account, `${UPLOAD}/files/${encodeURIComponent(fileId)}`, "PATCH", {}, input.bytes, "application/vnd.google.colaboratory", signal)
      return imageOf(await response.json())
    }
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    const response = await this.send(account, url.toString(), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: input.trashed ?? false }) }, signal, false)
    return imageOf(await response.json())
  }

  async keptRevisions(account: string, fileId: string, signal: AbortSignal): Promise<{ readonly kept: number; readonly truncated: boolean }> {
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}/revisions`)
    url.searchParams.set("fields", "nextPageToken,revisions(id,keepForever)")
    url.searchParams.set("pageSize", "1000")
    url.searchParams.set("supportsAllDrives", "true")
    let kept = 0
    let token: string | undefined
    for (let page = 0; page < 10; page += 1) {
      if (token !== undefined) url.searchParams.set("pageToken", token)
      else url.searchParams.delete("pageToken")
      const response = await this.send(account, url.toString(), { method: "GET" }, signal, true)
      const body = (await response.json().catch(() => ({}))) as { readonly revisions?: readonly { readonly keepForever?: boolean }[]; readonly nextPageToken?: unknown }
      for (const revision of body.revisions ?? []) if (revision.keepForever === true) kept += 1
      token = typeof body.nextPageToken === "string" ? body.nextPageToken : undefined
      if (token === undefined) return { kept, truncated: false }
    }
    return { kept, truncated: true }
  }

  async keepRevision(account: string, fileId: string, revisionId: string, signal: AbortSignal): Promise<boolean> {
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}`)
    url.searchParams.set("fields", "id,keepForever")
    url.searchParams.set("supportsAllDrives", "true")
    try {
      const response = await this.send(account, url.toString(), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ keepForever: true }) }, signal, false)
      await response.body?.cancel().catch(() => undefined)
      return true
    } catch (error) {
      // TODO(L8): record Drive's exact answer at the 200-revision cap. The cap is also counted at preview through
      // revisions.list, so this fallback is not the only signal; a refusal that names the limit is "not pinned".
      if (ColabError.is(error) && /revision/i.test(error.message) && /(200|limit|maximum)/i.test(error.message)) return false
      throw error
    }
  }
}

export function createHttpDriveApi(env: PortEnv): DriveApi {
  return new HttpDriveApi(env)
}
