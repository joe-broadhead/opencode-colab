// Package D's file tests (design §15.1 uploads, §6 upload/download, §7.5): secret names and contents, the host's read
// and edit, path refusals, a folder upload's all-or-nothing screen, chunked streaming through package B's real protocol
// and its proxy-in-front-of-Jupyter fake, and the Drive/GCS seams called with this call's providerRead. No Google call.
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { OPERATIONS } from "../../src/domain/actions.js"
import type { PortEnv } from "../../src/provider/index.js"
import { loadOptions } from "../../src/options.js"
import { createColabApi } from "../../src/provider/runtime/api.js"
import { createRuntimeProtocol } from "../../src/provider/runtime/protocol.js"
import { FakeAuth, FakeClock, fakeDeps, MemoryLedger } from "../fakes/index.js"
import { createFakeColabApi } from "../fakes/runtime-api.js"
import { createFakeJupyter } from "../fakes/runtime-jupyter.js"
import { prepared, runtimeRecord, tool } from "../fakes/execution-harness.js"
import { invented } from "../support/invented.js"

const made: string[] = []
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "colab-files-"))
  made.push(dir)
  return dir
}
afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

const KEY = "0123456789abcdef0123456789abcdef01234567"

describe("colab_upload", () => {
  it("uploads a file to /content/<name>, streaming it, and asks the host's read", async () => {
    const directory = await workspace()
    await writeFile(join(directory, "data.csv"), "a,b\n1,2\n")
    const { deps, fakes, record, runtime } = await prepared({ directory })
    let chunks = 0
    const original = runtime.files.write.bind(runtime.files)
    Object.assign(runtime.files, {
      write: async (target: { runtimeId: string }, path: string, bytes: AsyncIterable<Uint8Array>) => {
        const collected: Uint8Array[] = []
        for await (const chunk of bytes) {
          chunks += 1
          collected.push(chunk)
        }
        return original(target, path, (async function* () {
          yield Buffer.concat(collected)
        })())
      },
    })
    const { result } = tool(deps, "upload", { runtime: record.id, path: "data.csv" })
    const answer = (await result) as { state: string; runtime: string; to: string; bytes: number; sha256: string }
    expect(answer).toMatchObject({ state: "ok", runtime: record.id, to: "/content/data.csv", bytes: 8 })
    expect(answer.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(chunks).toBe(1)
    expect(fakes.colab.calls).toHaveLength(0)
    expect(Buffer.from(runtime.contents.get(record.id)!.get("/content/data.csv")!).toString()).toBe("a,b\n1,2\n")
  })

  it("streams a large file in more than one slice", async () => {
    const directory = await workspace()
    await writeFile(join(directory, "big.bin"), Buffer.alloc(2.5 * 1024 * 1024, 7))
    const { deps, record, runtime } = await prepared({ directory, options: { maxUploadBytes: "8MiB" } })
    let chunks = 0
    const original = runtime.files.write.bind(runtime.files)
    Object.assign(runtime.files, {
      write: async (target: { runtimeId: string }, path: string, bytes: AsyncIterable<Uint8Array>) => {
        const collected: Uint8Array[] = []
        for await (const chunk of bytes) {
          chunks += 1
          collected.push(chunk)
        }
        return original(target, path, (async function* () {
          yield Buffer.concat(collected)
        })())
      },
    })
    const { result } = tool(deps, "upload", { runtime: record.id, path: "big.bin" })
    expect((await result) as { bytes: number }).toMatchObject({ bytes: 2.5 * 1024 * 1024 })
    expect(chunks).toBeGreaterThan(1)
  })

  it("refuses a secret-shaped name or contents unless allowSecretUpload, and writes nothing", async () => {
    const directory = await workspace()
    await writeFile(join(directory, ".env"), "A=1\n")
    await writeFile(join(directory, "notes.txt"), `WANDB_API_KEY=${KEY}\n`)
    await writeFile(join(directory, "ok.txt"), "hello\n")
    const { deps, record, runtime } = await prepared({ directory })
    expect(await tool(deps, "upload", { runtime: record.id, path: ".env" }).result).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
    expect(await tool(deps, "upload", { runtime: record.id, path: "notes.txt" }).result).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
    expect(runtime.contents.get(record.id)).toBeUndefined()
    const allowed = await prepared({ directory, options: { allowSecretUpload: true } })
    expect(await tool(allowed.deps, "upload", { runtime: allowed.record.id, path: "notes.txt" }).result).toMatchObject({ state: "ok" })
    expect(existsSync(join(directory, "ok.txt"))).toBe(true)
  })

  it("refuses a symlink, a path outside the project, and a non-ours runtime, before any request", async () => {
    const directory = await workspace()
    const outside = await workspace()
    await writeFile(join(outside, "secret.txt"), "x")
    await symlink(join(outside, "secret.txt"), join(directory, "link.txt"))
    const { deps, record, runtime } = await prepared({ directory })
    expect(await tool(deps, "upload", { runtime: record.id, path: "link.txt" }).result).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect(await tool(deps, "upload", { runtime: record.id, path: join(outside, "secret.txt") }).result).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect(await tool(deps, "upload", { runtime: "oc-nope", path: "anything.txt" }).result).toMatchObject({ error: "INPUT_INVALID" })
    expect(runtime.calls).toHaveLength(0)
  })

  it("uploads a folder to <to>/<relative>, screening every file before writing any", async () => {
    const directory = await workspace()
    await mkdir(join(directory, "data", "nested"), { recursive: true })
    await writeFile(join(directory, "data", "a.csv"), "1\n")
    await writeFile(join(directory, "data", "nested", "b.txt"), "2\n")
    const { deps, record, runtime } = await prepared({ directory })
    const { result } = tool(deps, "upload", { runtime: record.id, path: "data", to: "/content/data" })
    const answer = (await result) as { state: string; to: string; bytes: number }
    expect(answer).toMatchObject({ state: "ok", to: "/content/data", bytes: 4 })
    expect([...runtime.contents.get(record.id)!.keys()].sort()).toEqual(["/content/data/a.csv", "/content/data/nested/b.txt"])

    await writeFile(join(directory, "data", "nested", "id_rsa"), ["-----BEGIN", "PRIVATE KEY-----"].join(" ") + "\n")
    const clean = await prepared({ directory })
    expect(await tool(clean.deps, "upload", { runtime: clean.record.id, path: "data", to: "/content/data" }).result).toMatchObject({ state: "refused", error: "PERMISSION_DENIED" })
    expect(clean.runtime.contents.get(clean.record.id)).toBeUndefined()
  })
})

describe("colab_download", () => {
  it("downloads a runtime file to the workDir, asks the host's edit, and hashes it", async () => {
    const directory = await workspace()
    const { deps, record, runtime } = await prepared({ directory })
    runtime.contents.set(record.id, new Map([["/content/out.csv", Buffer.from("a,b\n1,2\n")]]))
    const { result } = tool(deps, "download", { runtime: record.id, path: "/content/out.csv" })
    const answer = (await result) as { state: string; path: string; bytes: number; sha256: string; charts?: string }
    expect(answer).toMatchObject({ state: "ok", path: ".colab/files/out.csv", bytes: 8 })
    expect(answer.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(answer.charts).toContain("charts_quick")
    expect(await readFile(join(directory, ".colab", "files", "out.csv"), "utf8")).toBe("a,b\n1,2\n")
  })

  it("refuses to overwrite without overwrite, then writes over with it", async () => {
    const directory = await workspace()
    await mkdir(join(directory, ".colab", "files"), { recursive: true })
    await writeFile(join(directory, ".colab", "files", "x.txt"), "old")
    const { deps, record, runtime } = await prepared({ directory })
    runtime.contents.set(record.id, new Map([["/content/x.txt", Buffer.from("new")]]))
    expect(await tool(deps, "download", { runtime: record.id, path: "/content/x.txt" }).result).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    const answer = await tool(deps, "download", { runtime: record.id, path: "/content/x.txt", overwrite: true }).result
    expect(answer).toMatchObject({ state: "ok" })
    expect(await readFile(join(directory, ".colab", "files", "x.txt"), "utf8")).toBe("new")
  })

  it("asks external_directory when the destination is under an allowed root outside the project", async () => {
    const directory = await workspace()
    const root = await workspace()
    const { deps, record, runtime } = await prepared({ directory, options: { allowedRoots: [root] } })
    runtime.contents.set(record.id, new Map([["/content/x.txt", Buffer.from("x")]]))
    const { result } = tool(deps, "download", { runtime: record.id, path: "/content/x.txt", to: join(root, "x.txt") })
    expect(await result).toMatchObject({ state: "ok" })
  })

  it("passes providerRead to the Drive and GCS seams, and never a runtime call", async () => {
    const directory = await workspace()
    const { deps, fakes } = await prepared({ directory })
    const { result } = tool(deps, "download", { drive: "file-1", to: "drive.ipynb" })
    await result
    expect(fakes.driveSync.calls).toHaveLength(1)
    expect(fakes.runtime.calls).toHaveLength(0)

    const gcs = tool(deps, "download", { gcs: "gs://b/o.ipynb", to: "gcs.ipynb" })
    await gcs.result
    expect(fakes.enterprise.calls).toHaveLength(1)
  })

  it("refuses a runtime file on a runtime that is not the plugin's own, before any request", async () => {
    const directory = await workspace()
    const { deps, runtime } = await prepared({ directory })
    expect(await tool(deps, "download", { runtime: "oc-nope", path: "/content/x" }).result).toMatchObject({ error: "INPUT_INVALID" })
    expect(runtime.calls).toHaveLength(0)
  })
})

// Package B's real transport in front of its proxy-and-Jupyter fake, with the contents write capped tiny, so D's
// streaming and B's chunked `PUT /api/contents` are exercised end to end. Jupyter's AsyncLargeFileManager takes the
// `chunk` pieces (design §18 [19]; package B's tests hold the wire format), and the fake records each piece.
describe("upload through the real transport", () => {
  const open: { close(): Promise<void> }[] = []
  afterAll(async () => {
    for (const item of open) await item.close()
  })

  it("sends a file over the contents cap in B's chunked write, byte-exact", async () => {
    const directory = await workspace()
    const jupyter = await createFakeJupyter({ token: invented("proxy-token-", "d") })
    const api = await createFakeColabApi({ runtimeUrl: jupyter.url, runtimeToken: invented("proxy-token-", "d") })
    open.push(jupyter, api)
    const options = loadOptions({})
    const auth = new FakeAuth()
    auth.grants.set("default", ["https://www.googleapis.com/auth/colaboratory"])
    const ledger = new MemoryLedger()
    const env: PortEnv = {
      options,
      directory,
      clock: new FakeClock(),
      auth,
      ledger,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof request === "string" || request instanceof URL ? request.toString() : request.url)
        if (url.origin === new URL(jupyter.url).origin) return globalThis.fetch(request as RequestInfo, init)
        if (url.origin !== "https://colaboratory.googleapis.com") throw new Error(`EXTERNAL_FETCH_BLOCKED: ${url.origin}`)
        return globalThis.fetch(new URL(`${api.url}${url.pathname}${url.search}`), init)
      }) as unknown as typeof fetch,
    }
    const protocol = createRuntimeProtocol(env, createColabApi(env, { retryDelaysMs: [0, 0], operationPollMs: 0 }), { allowLoopback: true, maxContentsBytes: 1024 })
    const record = runtimeRecord({ id: "oc-01jexecchunk000000000000" })
    await ledger.putRuntime(record)
    api.runtimes.set(record.id, {
      id: record.id,
      spec: { ...record.spec, eligible: true },
      requestId: "request-chunk",
      connection: { url: jupyter.url, token: invented("proxy-token-", "d"), expireTime: new Date(Date.now() + 3_600_000).toISOString() },
    })
    const base = fakeDeps({ directory, options: {} })
    const deps = { ...base.deps, runtime: protocol, ledger }
    const big = Buffer.alloc(3000, 5)
    await writeFile(join(directory, "big.txt"), big)
    const answer = await tool(deps, "upload", { runtime: record.id, path: "big.txt" }).result
    expect(answer).toMatchObject({ state: "ok", bytes: 3000 })
    expect(jupyter.chunksSeen.length).toBeGreaterThan(1)
    const stored = [...jupyter.contents.entries()].find(([path]) => path.endsWith("big.txt"))
    expect(stored).toBeDefined()
    expect(Buffer.compare(Buffer.from(stored![1]), big)).toBe(0)
  })
})
