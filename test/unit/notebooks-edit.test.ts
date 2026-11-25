// Package C's must-prove item "every colab_edit op; ifHash" (design §15.1) and H8's `colab_edit` half: the six edit
// operations plus create, an edit all or nothing, a no-op edit that writes nothing and path refusals.
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { cellSource, notebookHash, parseNotebook } from "../../src/provider/notebooks/model.js"
import { resolveWorkspacePath } from "../../src/provider/notebooks/paths.js"
import { toolHandlers } from "../support/legacy.js"
import { runTool, type Runner } from "../support/legacy.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"

const call = (id = "call_1") => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id, signal: new AbortController().signal })
const fixture = (cells: unknown[], minor = 4): string => JSON.stringify({ cells, metadata: {}, nbformat: 4, nbformat_minor: minor }, null, 1)
const codeCell = (source: string, outputs: unknown[] = [], executionCount: number | null = null) => ({ cell_type: "code", execution_count: executionCount, metadata: {}, outputs, source })
const markdown = (source: string) => ({ cell_type: "markdown", metadata: {}, source })
const stream = (text: string) => ({ name: "stdout", output_type: "stream", text })

let directory: string
let outside: string
let runner: Runner
let permission: RecordingPermission

function setup(options: unknown = {}): void {
  const deps = fakeDeps({ options: { ...(options as object), allowedRoots: [outside] }, directory }).deps
  permission = new RecordingPermission()
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "colab-notebooks-edit-"))
  outside = mkdtempSync(join(tmpdir(), "colab-notebooks-outside-"))
  setup()
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

const write = (path: string, text: string) => writeFileSync(join(directory, path), text)
const read = (path: string) => readFileSync(join(directory, path))

describe("colab_edit", () => {
  it("creates a notebook with a kernel, persists ids and raises the minor to 5", async () => {
    const result = (await runTool("edit", { path: "new.ipynb", ops: [{ op: "create", kernel: "python3", cells: [{ type: "code", source: "print(1)\n" }] }] }, call(), runner)) as { state: string; hash: string; cells: number; path: string }
    expect(result).toMatchObject({ state: "ok", cells: 1, path: "new.ipynb" })
    const bytes = read("new.ipynb")
    expect(result.hash).toBe(notebookHash(bytes))
    const notebook = parseNotebook(bytes)
    expect(notebook.nbformatMinor).toBe(5)
    expect(notebook.cells[0]!.derived).toBe(false)
    expect(notebook.cells[0]!.json.id).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    expect(notebook.metadata.kernelspec).toEqual({ name: "python3", display_name: "python3" })
  })

  it("refuses create over an existing file with FILE_EXISTS", async () => {
    write("taken.ipynb", fixture([codeCell("x")]))
    expect(await runTool("edit", { path: "taken.ipynb", ops: [{ op: "create" }] }, call(), runner)).toMatchObject({ state: "refused", error: "FILE_EXISTS" })
  })

  it("applies insert (index, after, before), replace, delete, move, clearOutputs and setMetadata", async () => {
    write("doc.ipynb", fixture([codeCell("a", [stream("out\n")], 1), markdown("b")]))
    const first = parseNotebook(read("doc.ipynb")).cells[0]!.id
    const second = parseNotebook(read("doc.ipynb")).cells[1]!.id
    const hash = notebookHash(read("doc.ipynb"))

    const inserted = (await runTool("edit", { path: "doc.ipynb", ifHash: hash, ops: [{ op: "insert", at: 1, cell: { type: "raw", source: "c" } }, { op: "insert", at: { after: second }, cell: { type: "markdown", source: "d" } }, { op: "insert", at: { before: first }, cell: { type: "markdown", source: "e" } }] }, call(), runner)) as { hash: string }
    let notebook = parseNotebook(read("doc.ipynb"))
    expect(notebook.cells.map((cell) => cell.json.source)).toEqual(["e", "a", "c", "b", "d"])

    await runTool("edit", { path: "doc.ipynb", ifHash: inserted.hash, ops: [{ op: "replace", cell: first, source: "A" }, { op: "move", cell: first, to: 4 }, { op: "delete", cell: second }, { op: "clearOutputs" }, { op: "setMetadata", cell: first, metadata: { tags: ["keep"] } }, { op: "setMetadata", metadata: { colab_origin: "me@example.com" } }] }, call(), runner)
    notebook = parseNotebook(read("doc.ipynb"))
    // move follows nbformat's move_cell: pop the cell, then insert it at the target index.
    expect(notebook.cells.map((cell) => cell.json.source)).toEqual(["e", "c", "d", "A"])
    expect(notebook.cells[3]!.json.outputs).toEqual([])
    expect(notebook.cells[3]!.json.execution_count).toBeNull()
    expect(notebook.cells[3]!.json.metadata).toEqual({ tags: ["keep"] })
    expect(notebook.metadata.colab_origin).toBe("me@example.com")
  })

  it("clears only the cells a selector names", async () => {
    write("doc.ipynb", fixture([codeCell("a", [stream("1\n")], 1), codeCell("b", [stream("2\n")], 2)]))
    const hash = notebookHash(read("doc.ipynb"))
    await runTool("edit", { path: "doc.ipynb", ifHash: hash, ops: [{ op: "clearOutputs", cells: [0] }] }, call(), runner)
    const notebook = parseNotebook(read("doc.ipynb"))
    expect(notebook.cells[0]!.json.outputs).toEqual([])
    expect(notebook.cells[1]!.json.outputs).toHaveLength(1)
  })

  it("serializes two concurrent edits with one ifHash, so neither is lost (review probe P1)", async () => {
    write("doc.ipynb", fixture([codeCell("x = 1")]))
    const hash = notebookHash(read("doc.ipynb"))
    const results = (await Promise.all([
      runTool("edit", { path: "doc.ipynb", ifHash: hash, ops: [{ op: "insert", at: 1, cell: { type: "code", source: "FIRST" } }] }, call("c_a"), runner),
      runTool("edit", { path: "doc.ipynb", ifHash: hash, ops: [{ op: "insert", at: 1, cell: { type: "code", source: "SECOND" } }] }, call("c_b"), runner),
    ])) as { state: string; error?: string }[]
    expect(results.map((result) => result.state).sort()).toEqual(["ok", "refused"])
    expect(results.find((result) => result.state === "refused")).toMatchObject({ error: "NOTEBOOK_CHANGED" })
    const sources = parseNotebook(read("doc.ipynb")).cells.map((cell) => cellSource(cell))
    expect(sources).toContain("x = 1")
    expect(sources.filter((source) => source === "FIRST" || source === "SECOND")).toHaveLength(1)
  })

  it("ends a rewritten file with a newline, as nbformat.write does (review probe P5)", async () => {
    write("doc.ipynb", fixture([codeCell("a")]))
    await runTool("edit", { path: "doc.ipynb", ifHash: notebookHash(read("doc.ipynb")), ops: [{ op: "replace", cell: 0, source: "b" }] }, call(), runner)
    expect(read("doc.ipynb").toString("utf8").endsWith("\n")).toBe(true)
  })

  it("refuses to rewrite a notebook holding an integer JSON cannot keep exactly (review probe P5)", async () => {
    const text = fixture([codeCell("x")]).replace('"metadata": {}', '"metadata": {"big": 12345678901234567890}')
    write("doc.ipynb", text)
    const before = read("doc.ipynb")
    const result = await runTool("edit", { path: "doc.ipynb", ifHash: notebookHash(before), ops: [{ op: "replace", cell: 0, source: "y" }] }, call(), runner)
    expect(result).toMatchObject({ state: "refused", error: "NOTEBOOK_INVALID" })
    expect(read("doc.ipynb")).toEqual(before)
  })

  it("requires ifHash for anything but create", async () => {
    write("doc.ipynb", fixture([codeCell("a")]))
    expect(await runTool("edit", { path: "doc.ipynb", ops: [{ op: "replace", cell: 0, source: "b" }] }, call(), runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
  })

  it("answers NOTEBOOK_CHANGED and writes nothing when ifHash is not the file's hash", async () => {
    write("doc.ipynb", fixture([codeCell("a")]))
    const before = read("doc.ipynb")
    const wrong = `sha256:${"0".repeat(64)}`
    expect(await runTool("edit", { path: "doc.ipynb", ifHash: wrong, ops: [{ op: "replace", cell: 0, source: "b" }] }, call(), runner)).toMatchObject({ state: "refused", error: "NOTEBOOK_CHANGED" })
    expect(read("doc.ipynb")).toEqual(before)
  })

  it("is all or nothing: a later bad cell leaves the file byte for byte", async () => {
    write("doc.ipynb", fixture([codeCell("a")]))
    const before = read("doc.ipynb")
    const hash = notebookHash(before)
    const result = await runTool("edit", { path: "doc.ipynb", ifHash: hash, ops: [{ op: "replace", cell: 0, source: "b" }, { op: "delete", cell: 9 }] }, call(), runner)
    expect(result).toMatchObject({ state: "refused", error: "NOT_FOUND" })
    expect(read("doc.ipynb")).toEqual(before)
  })

  it("writes nothing for an edit that changes nothing", async () => {
    write("doc.ipynb", fixture([codeCell("a")]))
    const before = read("doc.ipynb")
    const result = (await runTool("edit", { path: "doc.ipynb", ifHash: notebookHash(before), ops: [{ op: "replace", cell: 0, source: "a" }] }, call(), runner)) as { hash: string }
    expect(result.hash).toBe(notebookHash(before))
    expect(read("doc.ipynb")).toEqual(before)
  })

  it("refuses a path outside the project and a symlink, and allows an allowedRoot with external_directory", async () => {
    expect(await runTool("edit", { path: "../escape.ipynb", ops: [{ op: "create" }] }, call(), runner)).toMatchObject({ state: "refused", error: "PATH_REFUSED" })
    write("real.ipynb", fixture([codeCell("a")]))
    symlinkSync(join(directory, "real.ipynb"), join(directory, "link.ipynb"))
    expect(await runTool("edit", { path: "link.ipynb", ifHash: notebookHash(read("real.ipynb")), ops: [{ op: "clearOutputs" }] }, call(), runner)).toMatchObject({ state: "refused", error: "PATH_REFUSED" })

    const target = join(outside, "rooted.ipynb")
    const result = (await runTool("edit", { path: target, ops: [{ op: "create", cells: [{ type: "code", source: "x" }] }] }, call(), runner)) as { state: string; path: string }
    expect(result.state).toBe("ok")
    expect(result.path).toBe(target)
  })
})
