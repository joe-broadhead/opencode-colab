// Package C's must-prove item "colab_find": the workspace glob, Drive under drive.file (the Colab MIME type and the
// search query the Drive guide documents, with its escaping), and GCS on an enterprise account.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { OPERATIONS } from "../../src/domain/actions.js"
import { COLAB_MIME, driveQuery } from "../../src/provider/notebooks/find.js"
import { runTool, type Runner } from "../support/methods.js"
import { fakeDeps, type Fakes } from "../fakes/index.js"

const call = () => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id: "call_1", signal: new AbortController().signal })

let directory: string
let runner: Runner

function setup(options: unknown = {}): { fakes: Fakes } {
  const { deps, fakes } = fakeDeps({ options, directory })
  runner = { deps }
  return { fakes }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "colab-notebooks-find-"))
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const touch = (path: string) => {
  mkdirSync(join(directory, path, ".."), { recursive: true })
  writeFileSync(join(directory, path), "{}")
}

describe("colab_find in the workspace", () => {
  it("globs notebooks, skips dot folders and node_modules, and marks a page cut", async () => {
    touch("a.ipynb")
    touch("dir/b.ipynb")
    touch("dir/deep/c.ipynb")
    touch("notes.txt")
    touch(".hidden/d.ipynb")
    touch("node_modules/e.ipynb")
    setup()
    const all = (await runTool("find", { where: "workspace", pattern: "**/*.ipynb" }, call(), runner)) as { state: string; trust: string; notebooks: { path: string; name: string }[]; truncated?: boolean }
    expect(all.state).toBe("ok")
    expect(all.trust).toBe("untrusted")
    expect(all.notebooks.map((entry) => entry.path)).toEqual(["a.ipynb", "dir/b.ipynb", "dir/deep/c.ipynb"])
    expect(all.truncated).toBeUndefined()

    const one = (await runTool("find", { where: "workspace", pattern: "*.ipynb" }, call(), runner)) as { notebooks: { path: string }[] }
    expect(one.notebooks.map((entry) => entry.path)).toEqual(["a.ipynb"])
    const shallow = (await runTool("find", { where: "workspace", pattern: "dir/*.ipynb" }, call(), runner)) as { notebooks: { path: string }[] }
    expect(shallow.notebooks.map((entry) => entry.path)).toEqual(["dir/b.ipynb"])

    const page = (await runTool("find", { where: "workspace", limit: 2 }, call(), runner)) as { notebooks: unknown[]; truncated?: boolean }
    expect(page.notebooks).toHaveLength(2)
    expect(page.truncated).toBe(true)
    expect(await runTool("find", { where: "workspace", pattern: "../outside/*.ipynb" }, call(), runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    // A workspace read is local: it asserts only its own action, and the refused pattern asserted nothing.
  })
})

describe("colab_find in Drive", () => {
  it("asks for Colab's MIME type under drive.file, escaped, with a read on drive.files.list", async () => {
    const { fakes } = setup()
    fakes.drive.files.set("f1", { file: { id: "f1", name: "budget's paper.ipynb", mimeType: COLAB_MIME, modifiedTime: "2026-11-17T09:00:00.000Z", lastModifyingUser: "me@example.com" }, bytes: Buffer.from("{}") })
    const result = (await runTool("find", { where: "drive", pattern: "budget's" }, call(), runner)) as { state: string; notebooks: { where: string; drive: string; name: string; modified?: string; owner?: string }[]; truncated?: boolean }
    expect(result.state).toBe("ok")
    expect(result.notebooks).toEqual([{ where: "drive", drive: "f1", name: "budget's paper.ipynb", modified: "2026-11-17T09:00:00.000Z", owner: "me@example.com" }])
    expect(result.truncated).toBeUndefined()
    expect(fakes.drive.calls[0]!.args[1]).toEqual({ query: "mimeType = 'application/vnd.google.colaboratory' and trashed = false and name contains 'budget\\'s'", pageSize: 50 })
    // A page that comes back exactly full may hide more: truncated.
    const page = (await runTool("find", { where: "drive", limit: 1 }, call(), runner)) as { truncated?: boolean }
    expect(page.truncated).toBe(true)
  })

  it("builds the documented query, with no name term when no pattern is given", () => {
    expect(driveQuery(undefined)).toBe("mimeType = 'application/vnd.google.colaboratory' and trashed = false")
    expect(driveQuery("a\\b")).toBe("mimeType = 'application/vnd.google.colaboratory' and trashed = false and name contains 'a\\\\b'")
  })

  it("lists notebooks the plugin pulled into the workDir (review LOW 10)", async () => {
    mkdirSync(join(directory, ".colab/files"), { recursive: true })
    writeFileSync(join(directory, ".colab/files/pulled.ipynb"), "{}")
    setup()
    const result = (await runTool("find", { where: "workspace" }, call(), runner)) as { notebooks: { path: string }[] }
    expect(result.notebooks.map((entry) => entry.path)).toContain(".colab/files/pulled.ipynb")
  })

  it("refuses Drive on an account that was not signed in with drive.file", async () => {
    setup({ accounts: { work: { drive: false } } })
    expect(await runTool("find", { where: "drive" }, call(), runner)).toMatchObject({ state: "refused", error: "SCOPE_MISSING" })
  })
})

describe("colab_find under a gs:// prefix", () => {
  it("lists notebook objects on an enterprise account, defaulting to outputBucket", async () => {
    const { fakes } = setup({ accounts: { ent: { backend: "enterprise", project: "p", region: "us-central1", outputBucket: "gs://bucket/out" } } })
    fakes.gcs.objects.set("gs://bucket/out/a.ipynb", Buffer.from("{}"))
    fakes.gcs.objects.set("gs://bucket/out/b.csv", Buffer.from("x"))
    const result = (await runTool("find", { account: "ent", where: "gcs" }, call(), runner)) as { notebooks: { where: string; gcs: string; name: string }[] }
    expect(result.notebooks).toEqual([{ where: "gcs", gcs: "gs://bucket/out/a.ipynb", name: "a.ipynb" }])
  })

  it("refuses gs:// on a colab account", async () => {
    setup()
    expect(await runTool("find", { where: "gcs", prefix: "gs://bucket/out" }, call(), runner)).toMatchObject({ state: "refused", error: "SCOPE_MISSING" })
  })
})
