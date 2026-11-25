// Package C's Drive API shapes: every request the plugin makes to Drive, against a recorded fetch (no network), with
// the Drive API v3 documented URLs, the one drive.file scope, the multipart and resumable uploads, pre-generated ids,
// alt=media, revisions.update's keepForever and its 200 cap, and the documented error reasons. This is the shape L8
// confirms against a real account.
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { PortEnv } from "../../src/provider/index.js"
import { DRIVE_SCOPE } from "../../src/provider/notebooks/account.js"
import { createHttpDriveApi } from "../../src/provider/notebooks/drive-api.js"
import { loadOptions } from "../../src/options.js"
import { FakeAuth, FakeClock, MemoryLedger } from "../fakes/index.js"

type FetchArgs = Parameters<typeof fetch>
interface Recorded {
  readonly url: string
  readonly init: FetchArgs[1]
}

function scripted(respond: (request: Recorded, count: number) => Response | Promise<Response>, options: unknown = {}): { env: PortEnv; calls: Recorded[]; auth: FakeAuth } {
  const calls: Recorded[] = []
  const auth = new FakeAuth()
  auth.grants.set("default", [DRIVE_SCOPE])
  const fetching = async (input: FetchArgs[0], init?: FetchArgs[1]): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as { readonly url: string }).url
    const request = { url, init }
    calls.push(request)
    return respond(request, calls.length)
  }
  const clock = new FakeClock()
  return {
    auth,
    calls,
    env: { options: loadOptions(options), directory: "/project", clock, auth, ledger: new MemoryLedger(clock), fetch: fetching as unknown as typeof fetch },
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const file = (overrides: Record<string, unknown> = {}) => ({ id: "generated-1", name: "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: "rev-1", modifiedTime: "2026-11-17T09:00:00.000Z", ownedByMe: true, lastModifyingUser: { emailAddress: "me@example.com" }, ...overrides })
const body = (request: Recorded) => Buffer.from(request.init?.body as Uint8Array).toString("utf8")
const header = (request: Recorded, name: string) => (request.init?.headers as Record<string, string> | undefined)?.[name]
const generateIds = () => json({ ids: ["generated-1"], space: "drive", kind: "drive#generatedIds" })
const big = (size: number) => new Uint8Array(size)

describe("the Drive API client", () => {
  it("lists with the documented q, pageSize, spaces and fields, with drive.file only", async () => {
    const { env, calls, auth } = scripted(() => json({ files: [file()] }))
    const files = await createHttpDriveApi(env).list("default", { query: "name contains 'a'", pageSize: 10 }, new AbortController().signal)
    expect(files).toEqual([{ id: "generated-1", name: "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: "rev-1", modifiedTime: "2026-11-17T09:00:00.000Z", ownedByMe: true, lastModifyingUser: "me@example.com" }])
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/drive/v3/files")
    expect(url.searchParams.get("q")).toBe("name contains 'a'")
    expect(url.searchParams.get("pageSize")).toBe("10")
    expect(url.searchParams.get("spaces")).toBe("drive")
    expect(url.searchParams.get("fields")).toContain("lastModifyingUser(emailAddress)")
    expect(calls[0]!.init?.method).toBe("GET")
    expect(header(calls[0]!, "Authorization")).toBe("Bearer fake-token-default")
    expect(auth.calls[0]!.args[1]).toEqual([DRIVE_SCOPE])
  })

  it("gets metadata, and answers undefined for a file Drive does not show it", async () => {
    const { env } = scripted(() => json({ error: { code: 404, errors: [{ reason: "notFound" }] } }, 404))
    expect(await createHttpDriveApi(env).get("default", "missing", new AbortController().signal)).toBeUndefined()
  })

  it("downloads with alt=media", async () => {
    const { env, calls } = scripted(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    expect([...(await createHttpDriveApi(env).download("default", "f1", new AbortController().signal))]).toEqual([1, 2, 3])
    const url = new URL(calls[0]!.url)
    expect(url.searchParams.get("alt")).toBe("media")
    expect(url.pathname).toBe("/drive/v3/files/f1")
  })

  it("creates small files with a pre-generated id in a multipart upload", async () => {
    const { env, calls } = scripted((request) => (new URL(request.url).pathname.endsWith("/files/generateIds") ? generateIds() : json(file({ name: "analysis.ipynb" }))))
    await createHttpDriveApi(env).create("default", { name: "analysis.ipynb", folder: "folder1", bytes: Buffer.from("{\"cells\":[]}"), mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal)
    expect(new URL(calls[0]!.url).pathname).toBe("/drive/v3/files/generateIds")
    expect(new URL(calls[0]!.url).searchParams.get("type")).toBe("files")
    const upload = new URL(calls[1]!.url)
    expect(upload.origin + upload.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files")
    expect(upload.searchParams.get("uploadType")).toBe("multipart")
    expect(calls[1]!.init?.method).toBe("POST")
    expect(header(calls[1]!, "Content-Type")).toMatch(/^multipart\/related; boundary=oc-/)
    const text = body(calls[1]!)
    expect(text).toContain('"id":"generated-1"')
    expect(text).toContain('"name":"analysis.ipynb"')
    expect(text).toContain('"mimeType":"application/vnd.google.colaboratory"')
    expect(text).toContain('"parents":["folder1"]')
    expect(text).toContain("{\"cells\":[]}")
  })

  it("uploads above 5 MB with a resumable session and resumes from a 308 (guides/manage-uploads)", async () => {
    const bytes = big(5 * 1024 * 1024 + 10)
    let puts = 0
    const { env, calls } = scripted((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/generateIds")) return generateIds()
      if (url.pathname === "/upload/drive/v3/files" && request.init?.method === "POST") {
        return new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1" } })
      }
      if (url.hostname === "www.googleapis.com" && request.init?.method === "PUT") {
        puts += 1
        if (puts === 1) return new Response(null, { status: 308, headers: { range: "bytes=0-1048575" } })
        return json(file({ name: "big.ipynb" }))
      }
      return json({ error: { code: 500 } }, 500)
    })
    const created = await createHttpDriveApi(env).create("default", { name: "big.ipynb", bytes, mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal)
    expect(created.id).toBe("generated-1")
    const initiate = calls[1]!
    expect(new URL(initiate.url).searchParams.get("uploadType")).toBe("resumable")
    expect(header(initiate, "X-Upload-Content-Type")).toBe("application/vnd.google.colaboratory")
    expect(header(initiate, "X-Upload-Content-Length")).toBe(String(bytes.length))
    expect(body(initiate)).toContain('"id":"generated-1"')
    const firstPut = calls[2]!
    expect(new URL(firstPut.url).searchParams.get("upload_id")).toBe("session-1")
    expect(header(firstPut, "Content-Length")).toBe(String(bytes.length))
    const secondPut = calls[3]!
    expect(header(secondPut, "Content-Range")).toBe(`bytes 1048576-${bytes.length - 1}/${bytes.length}`)
  })

  it("joins a pre-generated id on 409, and retries an upload after a 5xx", async () => {
    const bytes = Buffer.from("{\"cells\":[]}")
    let posts = 0
    const { env, calls } = scripted((request) => {
      const url = new URL(request.url)
      if (url.pathname.endsWith("/generateIds")) return generateIds()
      if (url.pathname === "/upload/drive/v3/files") {
        posts += 1
        return posts === 1 ? json({ error: { code: 500 } }, 500) : posts === 2 ? json({ error: { code: 409 } }, 409) : json(file())
      }
      if (url.pathname === "/drive/v3/files/generated-1") return json(file())
      return json({ error: { code: 500 } }, 500)
    })
    const joined = await createHttpDriveApi(env).create("default", { name: "analysis.ipynb", bytes, mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal)
    expect(joined.id).toBe("generated-1")
    // The 5xx was retried with the same pre-generated id, and the 409 read the file back instead of making another.
    const uploads = calls.filter((call) => new URL(call.url).pathname === "/upload/drive/v3/files" && call.init?.method === "POST")
    expect(uploads).toHaveLength(2)
    expect(uploads.every((call) => body(call).includes('"id":"generated-1"'))).toBe(true)
    expect(calls.some((call) => new URL(call.url).pathname === "/drive/v3/files/generated-1" && call.init?.method === "GET")).toBe(true)
  })

  it("refuses a file over maxUploadBytes before any request", async () => {
    const { env, calls } = scripted(() => json(file()), { maxUploadBytes: "6MiB" })
    const failure = await Promise.resolve(createHttpDriveApi(env).create("default", { name: "big.ipynb", bytes: big(6 * 1024 * 1024 + 1), mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal)).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "FILE_TOO_LARGE" })
    expect(calls).toHaveLength(0)
  })

  it("updates small bytes with uploadType=media, big bytes with a resumable PATCH, and trashes with a patch", async () => {
    const small = scripted(() => json(file({ headRevisionId: "rev-2" })))
    const api = createHttpDriveApi(small.env)
    await api.update("default", "f1", { bytes: Buffer.from("new") }, new AbortController().signal)
    expect(new URL(small.calls[0]!.url).searchParams.get("uploadType")).toBe("media")
    expect(small.calls[0]!.init?.method).toBe("PATCH")
    expect(header(small.calls[0]!, "Content-Type")).toBe("application/vnd.google.colaboratory")
    await api.update("default", "f1", { trashed: true }, new AbortController().signal)
    expect(new URL(small.calls[1]!.url).pathname).toBe("/drive/v3/files/f1")
    expect(body(small.calls[1]!)).toBe('{"trashed":true}')

    const resumable = scripted((request) => (request.init?.method === "PATCH" && new URL(request.url).pathname.startsWith("/upload/") ? new Response(null, { status: 200, headers: { location: "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=u2" } }) : json(file({ headRevisionId: "rev-3" }))))
    await createHttpDriveApi(resumable.env).update("default", "f1", { bytes: big(5 * 1024 * 1024 + 1) }, new AbortController().signal)
    expect(new URL(resumable.calls[0]!.url).searchParams.get("uploadType")).toBe("resumable")
    expect(resumable.calls[0]!.init?.method).toBe("PATCH")
    expect(resumable.calls[1]!.init?.method).toBe("PUT")
  })

  it("pins a revision with keepForever, and answers false at Drive's 200-revision cap", async () => {
    let answer = 0
    const { env, calls } = scripted(() => {
      answer += 1
      // The cap's exact reason is not recorded; this fixture stands in for it.
      if (answer === 1) return json({ id: "rev-1", keepForever: true })
      return json({ error: { code: 403, errors: [{ reason: "revisionLimitExceeded", message: "The maximum number of 200 revisions has been reached." }] } }, 403)
    })
    const api = createHttpDriveApi(env)
    expect(await api.keepRevision("default", "f1", "rev-1", new AbortController().signal)).toBe(true)
    expect(new URL(calls[0]!.url).pathname).toBe("/drive/v3/files/f1/revisions/rev-1")
    expect(body(calls[0]!)).toBe('{"keepForever":true}')
    expect(calls[0]!.init?.method).toBe("PATCH")
    expect(await api.keepRevision("default", "f1", "rev-1", new AbortController().signal)).toBe(false)
  })

  it("maps Drive's documented errors to the plugin's codes, and copies none of Google's words", async () => {
    const cases: { status: number; reason: string; code: string; headers?: Record<string, string> }[] = [
      { status: 401, reason: "authError", code: "AUTH_REQUIRED" },
      { status: 403, reason: "insufficientPermissions", code: "AUTH_SCOPE_MISSING" },
      { status: 403, reason: "rateLimitExceeded", code: "RATE_LIMITED", headers: { "retry-after": "7" } },
      { status: 403, reason: "userRateLimitExceeded", code: "RATE_LIMITED" },
      { status: 403, reason: "accessNotConfigured", code: "API_DISABLED" },
      { status: 403, reason: "storageQuotaExceeded", code: "PERMISSION_DENIED" },
      { status: 403, reason: "domainPolicy", code: "PERMISSION_DENIED" },
      { status: 404, reason: "notFound", code: "NOT_FOUND" },
      { status: 400, reason: "badRequest", code: "INPUT_INVALID" },
      { status: 429, reason: "rateLimitExceeded", code: "RATE_LIMITED" },
    ]
    for (const entry of cases) {
      const leaked = "LEAKED-GOOGLE-MESSAGE-12345"
      const { env } = scripted(() => json({ error: { code: entry.status, message: leaked, errors: [{ reason: entry.reason }] } }, entry.status, entry.headers))
      const failure = await Promise.resolve(createHttpDriveApi(env).list("default", {}, new AbortController().signal)).catch((error: unknown) => error)
      expect(failure, entry.reason).toBeInstanceOf(ColabError)
      expect((failure as ColabError).code, entry.reason).toBe(entry.code)
      expect((failure as ColabError).message, entry.reason).not.toContain(leaked)
    }
    const { env } = scripted(() => json({ error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } }, 403))
    const disabled = (await Promise.resolve(createHttpDriveApi(env).list("default", {}, new AbortController().signal)).catch((error: unknown) => error)) as ColabError
    expect(disabled.next).toContain("https://console.cloud.google.com/apis/library/drive.googleapis.com")
  })

  it("retries a GET on 429 and 5xx, never a write, and answers RATE_LIMITED or UNAVAILABLE after the last try", async () => {
    let attempt = 0
    const { env, calls } = scripted(() => {
      attempt += 1
      return attempt === 1 ? json({ error: { code: 429 } }, 429, { "retry-after": "0" }) : json({ files: [] })
    })
    await expect(createHttpDriveApi(env).list("default", {}, new AbortController().signal)).resolves.toEqual([])
    expect(calls).toHaveLength(2)

    const failing = scripted(() => json({ error: { code: 500 } }, 500))
    await expect(Promise.resolve(createHttpDriveApi(failing.env).list("default", {}, new AbortController().signal))).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(failing.calls).toHaveLength(3)
  })
})
