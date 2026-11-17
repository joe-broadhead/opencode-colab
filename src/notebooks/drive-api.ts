/**
 * Drive API v3 over `fetch` (design D2, Q5): `files.list`, `files.get` (`alt=media` for content), `files.create`
 * (a multipart upload), `files.update` (media, and `trashed`) and `revisions.update` (`keepForever`), with the one
 * scope `drive.file` — the plugin reaches only notebooks it created or was given.
 *
 * Shapes, from Google's Drive API v3 reference and guides:
 * - `files.list`: `q`, `pageSize` (at most 1000), `spaces`, `fields`; it returns trashed files unless asked otherwise
 *   (guides/reference/rest/v3/files/list).
 * - `files.get` with `alt=media` returns the file's bytes (reference/rest/v3/files/get; guides/manage-downloads).
 * - `files.create` accepts a multipart upload at the /upload URI with `uploadType=multipart`, and the metadata should
 *   carry a file extension in `name` (reference/rest/v3/files/create; guides/manage-uploads).
 * - `files.update` with `uploadType=media` replaces a file's bytes; a `trashed: true` patch moves it to the trash
 *   (reference/rest/v3/files/update; guides/trash).
 * - `revisions.update` is `PATCH /files/{fileId}/revisions/{revisionId}` and `keepForever` "can be set on a maximum of
 *   200 revisions for a file" (reference/rest/v3/revisions/update; guides/manage-revisions).
 *
 * Errors use Drive's documented reasons (`notFound`, `rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`,
 * `storageQuotaExceeded`, `domainPolicy`, `accessNotConfigured`; guides/handle-errors) and map to the plugin's codes.
 * A message contains only the plugin's words and the HTTP status and reason, never Google's message, a token or a name.
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
/** Drive's multipart and simple uploads take a file of 5 MB or less (guides/manage-uploads); resumable is out of scope. */
export const DRIVE_SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024
const RETRY_DELAYS_MS = [200, 600]
const ENABLE_DRIVE = "https://console.cloud.google.com/apis/library/drive.googleapis.com"
const RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"])
const DISABLED_REASONS = new Set(["accessNotConfigured", "serviceDisabled"])

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const retryable = (status: number) => status === 429 || status >= 500

interface DriveErrorBody {
  readonly error?: {
    readonly code?: number
    readonly status?: string
    readonly message?: string
    readonly errors?: readonly { readonly reason?: string }[]
    readonly details?: readonly { readonly reason?: string }[]
  }
}

function tooLarge(bytes: number): ColabError {
  return new ColabError("FILE_TOO_LARGE", `The notebook is ${bytes} bytes after output stripping, over Drive's 5 MB upload limit.`, {
    next: "Strip the outputs (the default), split the notebook, or push it from the Drive web app.",
  })
}

function reasonOf(body: DriveErrorBody | undefined): string | undefined {
  const fromList = body?.error?.errors?.find((entry) => typeof entry.reason === "string")?.reason
  if (fromList) return fromList
  const fromDetails = body?.error?.details?.find((entry) => typeof entry.reason === "string")?.reason
  return fromDetails
}

function retryAfterMs(response: Response, fallback: number): number {
  const header = response.headers.get("retry-after")
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds * 1000, 2_000) : fallback
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
  if (response.status === 400) return new ColabError("UNAVAILABLE", detail, { next: "Check the Drive folder id and the notebook's name, then try again." })
  if (response.status === 429) return new ColabError("RATE_LIMITED", detail, rateExtras(response))
  return new ColabError("UNAVAILABLE", detail)
}

const rateExtras = (response: Response): { readonly retryAfterSec?: number } => {
  const header = response.headers.get("retry-after")
  const seconds = header === null ? Number.NaN : Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? { retryAfterSec: Math.ceil(seconds) } : {}
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

export class HttpDriveApi implements DriveApi {
  constructor(private readonly env: PortEnv) {}

  private async token(account: string, signal: AbortSignal): Promise<string> {
    return this.env.auth.token(account, [DRIVE_SCOPE], signal)
  }

  /** One request with a 60 s bound and, for a GET, jittered retries on 429 and 5xx (design §9.4). */
  private async send(account: string, url: string, init: FetchInit, signal: AbortSignal, retry: boolean): Promise<Response> {
    const token = await this.token(account, signal)
    for (let attempt = 0; ; attempt += 1) {
      let response: Response
      try {
        response = await this.env.fetch(url, {
          ...init,
          headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
          signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        })
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        // A network failure is retried on an idempotent GET; a timeout is not retried on top of its own 60 s.
        if (retry && !(error instanceof Error && error.name === "TimeoutError") && attempt < RETRY_DELAYS_MS.length) {
          await sleep(RETRY_DELAYS_MS[attempt]! + Math.floor(Math.random() * 50))
          continue
        }
        throw new ColabError("UNAVAILABLE", "The request to Drive did not complete.", {
          next: "Check the network, then make the same call again.",
        })
      }
      if (response.ok) return response
      if (!retry || !retryable(response.status) || attempt >= RETRY_DELAYS_MS.length) throw await failureOf(response)
      const wait = retryAfterMs(response, RETRY_DELAYS_MS[attempt]!)
      await response.body?.cancel().catch(() => undefined)
      await sleep(wait + Math.floor(Math.random() * 50))
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

  async create(account: string, input: { readonly name: string; readonly folder?: string; readonly bytes: Uint8Array; readonly mimeType: string }, signal: AbortSignal): Promise<DriveFile> {
    if (input.bytes.length > DRIVE_SIMPLE_UPLOAD_MAX) throw tooLarge(input.bytes.length)
    const boundary = `oc-${randomUUID()}`
    const metadata = { name: input.name, mimeType: input.mimeType, ...(input.folder !== undefined ? { parents: [input.folder] } : {}) }
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`),
      Buffer.from(JSON.stringify(metadata), "utf8"),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: ${input.mimeType}\r\n\r\n`),
      Buffer.from(input.bytes),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    const url = new URL(`${UPLOAD}/files`)
    url.searchParams.set("uploadType", "multipart")
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    const response = await this.send(account, url.toString(), { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body }, signal, false)
    return imageOf(await response.json())
  }

  async update(account: string, fileId: string, input: { readonly bytes?: Uint8Array; readonly trashed?: boolean }, signal: AbortSignal): Promise<DriveFile> {
    if (input.bytes === undefined && input.trashed === undefined) throw new ColabError("INPUT_INVALID", "A Drive update needs bytes or trashed.")
    if (input.bytes !== undefined) {
      if (input.bytes.length > DRIVE_SIMPLE_UPLOAD_MAX) throw tooLarge(input.bytes.length)
      const url = new URL(`${UPLOAD}/files/${encodeURIComponent(fileId)}`)
      url.searchParams.set("uploadType", "media")
      url.searchParams.set("fields", FIELDS)
      url.searchParams.set("supportsAllDrives", "true")
      const response = await this.send(account, url.toString(), { method: "PATCH", headers: { "Content-Type": "application/vnd.google.colaboratory" }, body: Buffer.from(input.bytes) }, signal, false)
      return imageOf(await response.json())
    }
    const url = new URL(`${API}/files/${encodeURIComponent(fileId)}`)
    url.searchParams.set("fields", FIELDS)
    url.searchParams.set("supportsAllDrives", "true")
    const response = await this.send(account, url.toString(), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: input.trashed ?? false }) }, signal, false)
    return imageOf(await response.json())
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
      // TODO(L8): record Drive's exact answer at the 200-revision cap and match only it. Until then a refusal that
      // names the revision limit is reported as "not pinned" rather than failing a push that already landed.
      if (ColabError.is(error) && /revision/i.test(error.message) && /(200|limit|maximum)/i.test(error.message)) return false
      throw error
    }
  }
}

export function createHttpDriveApi(env: PortEnv): DriveApi {
  return new HttpDriveApi(env)
}
