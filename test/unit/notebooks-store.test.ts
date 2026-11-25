// The notebook store and its lock (review M1, contract request 2): one per-path lock serializes concurrent callers,
// and `mergeRun` merges a run's outputs by cell id into the file as it is now or refuses NOTEBOOK_CHANGED untouched.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PortEnv } from "../../src/provider/index.js"
import { notebookHash, parseNotebook } from "../../src/provider/notebooks/model.js"
import { createNotebookStore } from "../../src/provider/notebooks/store.js"
import { withNotebookLock } from "../../src/provider/notebooks/lock.js"
import { loadOptions } from "../../src/options.js"
import { FakeAuth, FakeClock, MemoryLedger } from "../fakes/index.js"

const fixture = JSON.stringify(
  {
    cells: [
      { cell_type: "code", execution_count: null, id: "c1", metadata: {}, outputs: [], source: "print(1)" },
      { cell_type: "markdown", id: "c2", metadata: {}, source: "# notes" },
    ],
    metadata: {},
    nbformat: 4,
    nbformat_minor: 5,
  },
  null,
  1,
)

let directory: string
let env: PortEnv

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "colab-notebooks-store-"))
  const clock = new FakeClock()
  env = { options: loadOptions({}), directory, clock, auth: new FakeAuth(), ledger: new MemoryLedger(clock), fetch: (() => Promise.reject(new Error("no network"))) as unknown as typeof fetch }
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe("the notebook store", () => {
  it("reads the cells colab_notebook shows, derived ids included, with the file's hash", async () => {
    writeFileSync(join(directory, "a.ipynb"), fixture)
    const read = await createNotebookStore(env).read("a.ipynb", new AbortController().signal)
    expect(read.hash).toBe(notebookHash(Buffer.from(fixture)))
    expect(read.cells.map((cell) => [cell.id, cell.type, cell.source])).toEqual([
      ["c1", "code", "print(1)"],
      ["c2", "markdown", "# notes"],
    ])
  })

  it("merges a run's outputs by cell id into the file, and refuses a changed run cell untouched", async () => {
    writeFileSync(join(directory, "a.ipynb"), fixture)
    const store = createNotebookStore(env)
    const first = await store.mergeRun("a.ipynb", { cells: [{ id: "c1", source: "print(1)", outputs: [{ output_type: "stream", name: "stdout", text: "1\n" }], executionCount: 4 }], outputDir: ".colab/runs/r1" }, new AbortController().signal)
    const after = parseNotebook(readFileSync(join(directory, "a.ipynb")))
    expect(after.cells[0]!.json.outputs).toHaveLength(1)
    expect(after.cells[0]!.json.execution_count).toBe(4)
    expect(first.hash).toBe(notebookHash(readFileSync(join(directory, "a.ipynb"))))

    const before = readFileSync(join(directory, "a.ipynb"))
    const failure = await Promise.resolve(store.mergeRun("a.ipynb", { cells: [{ id: "c1", source: "changed()", outputs: [], executionCount: 1 }], outputDir: ".colab/runs/r2" }, new AbortController().signal)).catch((error: unknown) => error)
    expect(failure).toMatchObject({ code: "NOTEBOOK_CHANGED" })
    expect(readFileSync(join(directory, "a.ipynb"))).toEqual(before)
  })

  it("holds one lock per path, in call order, and a failure does not block the next waiter", async () => {
    const order: string[] = []
    const first = withNotebookLock("/tmp/x.ipynb", async () => {
      order.push("first:start")
      await new Promise((resolve) => setTimeout(resolve, 20))
      order.push("first:end")
      throw new Error("first failed")
    })
    const second = withNotebookLock("/tmp/x.ipynb", async () => {
      order.push("second:start")
      order.push("second:end")
    })
    await expect(first).rejects.toThrow("first failed")
    await second
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"])
    // Another path is independent.
    const other: string[] = []
    await Promise.all([
      withNotebookLock("/tmp/y.ipynb", async () => void other.push("y")),
      withNotebookLock("/tmp/z.ipynb", async () => void other.push("z")),
    ])
    expect(other.sort()).toEqual(["y", "z"])
  })
})
