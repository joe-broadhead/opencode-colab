// Package C's Drive API shapes: every request the plugin makes to Drive, against a recorded fetch (no network), with
// the Drive API v3 documented URLs, the one drive.file scope, the multipart create, alt=media, revisions.update's
// keepForever and its 200 cap, and the documented error reasons. This is the shape L8 confirms against a real account.
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { PortEnv } from "../../src/deps.js"
import { DRIVE_SCOPE } from "../../src/notebooks/account.js"
import { createHttpDriveApi } from "../../src/notebooks/drive-api.js"
import { loadOptions } from "../../src/options.js"
import { FakeAuth, FakeClock, MemoryLedger } from "../fakes/index.js"

type FetchArgs = Parameters<typeof fetch>
interface Recorded {
  readonly url: string
  readonly init: FetchArgs[1]
}

function scripted(respond: (request: Recorded, count: number) => Response | Promise<Response>): { env: PortEnv; calls: Recorded[]; auth: FakeAuth } {
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
    env: { options: loadOptions({}), directory: "/project", clock, auth, ledger: new MemoryLedger(clock), fetch: fetching as unknown as typeof fetch },
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const file = (overrides: Record<string, unknown> = {}) => ({ id: "f1", name: "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: "rev-1", modifiedTime: "2026-11-17T09:00:00.000Z", ownedByMe: true, lastModifyingUser: { emailAddress: "me@example.com" }, ...overrides })
const body = (request: Recorded) => Buffer.from(request.init?.body as Uint8Array).toString("utf8")
const header = (request: Recorded, name: string) => (request.init?.headers as Record<string, string> | undefined)?.[name]

describe("the Drive API client", () => {
  it("lists with the documented q, pageSize, spaces and fields, with drive.file only", async () => {
    const { env, calls, auth } = scripted(() => json({ files: [file()] }))
    const files = await createHttpDriveApi(env).list("default", { query: "name contains 'a'", pageSize: 10 }, new AbortController().signal)
    expect(files).toEqual([{ id: "f1", name: "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: "rev-1", modifiedTime: "2026-11-17T09:00:00.000Z", ownedByMe: true, lastModifyingUser: "me@example.com" }])
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

  it("creates with a multipart upload carrying the notebook's name, MIME type, parent and bytes", async () => {
    const { env, calls } = scripted(() => json(file()))
    const bytes = Buffer.from("{\"cells\":[]}")
    await createHttpDriveApi(env).create("default", { name: "analysis.ipynb", folder: "folder1", bytes, mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal)
    const url = new URL(calls[0]!.url)
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/upload/drive/v3/files")
    expect(url.searchParams.get("uploadType")).toBe("multipart")
    expect(calls[0]!.init?.method).toBe("POST")
    expect(header(calls[0]!, "Content-Type")).toMatch(/^multipart\/related; boundary=oc-/)
    const text = body(calls[0]!)
    expect(text).toContain('"name":"analysis.ipynb"')
    expect(text).toContain('"mimeType":"application/vnd.google.colaboratory"')
    expect(text).toContain('"parents":["folder1"]')
    expect(text).toContain("{\"cells\":[]}")
  })

  it("refuses a create or a media update over Drive's 5 MB simple-upload limit", async () => {
    const { env, calls } = scripted(() => json(file()))
    const api = createHttpDriveApi(env)
    const tooBig = new Uint8Array(5 * 1024 * 1024 + 1)
    await expect(Promise.resolve(api.create("default", { name: "big.ipynb", bytes: tooBig, mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
    await expect(Promise.resolve(api.update("default", "f1", { bytes: tooBig }, new AbortController().signal))).rejects.toMatchObject({ code: "FILE_TOO_LARGE" })
    expect(calls).toHaveLength(0)
  })

  it("updates bytes with uploadType=media and trashes with a patch", async () => {
    const { env, calls } = scripted(() => json(file({ headRevisionId: "rev-2" })))
    const api = createHttpDriveApi(env)
    await api.update("default", "f1", { bytes: Buffer.from("new") }, new AbortController().signal)
    expect(new URL(calls[0]!.url).searchParams.get("uploadType")).toBe("media")
    expect(calls[0]!.init?.method).toBe("PATCH")
    expect(header(calls[0]!, "Content-Type")).toBe("application/vnd.google.colaboratory")
    await api.update("default", "f1", { trashed: true }, new AbortController().signal)
    expect(new URL(calls[1]!.url).pathname).toBe("/drive/v3/files/f1")
    expect(body(calls[1]!)).toBe('{"trashed":true}')
  })

  it("pins a revision with keepForever, and answers false at Drive's 200-revision cap", async () => {
    let answer = 0
    const { env, calls } = scripted(() => {
      answer += 1
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
      { status: 403, reason: "rateLimitExceeded", code: "RATE_LIMITED", headers: { "retry-after": "7" } },
      { status: 403, reason: "userRateLimitExceeded", code: "RATE_LIMITED" },
      { status: 403, reason: "accessNotConfigured", code: "API_DISABLED" },
      { status: 403, reason: "storageQuotaExceeded", code: "PERMISSION_DENIED" },
      { status: 403, reason: "domainPolicy", code: "PERMISSION_DENIED" },
      { status: 404, reason: "notFound", code: "NOT_FOUND" },
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
    // A 403 that disables the API names the console link to enable it.
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

    const write = scripted(() => json({ error: { code: 500 } }, 500))
    await expect(Promise.resolve(createHttpDriveApi(write.env).create("default", { name: "n.ipynb", bytes: Buffer.from("x"), mimeType: "application/vnd.google.colaboratory" }, new AbortController().signal))).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(write.calls).toHaveLength(1)
  })
})
