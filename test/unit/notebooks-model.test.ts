// Package C's must-prove item "the notebook model" (design §15.1): nbformat 4.0–4.5 round-trips byte for byte when
// unchanged, ids are derived in memory and never written by a read, every edit operation, and a run's outputs merge by
// cell id or answer NOTEBOOK_CHANGED.
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import {
  cellExecutionCount,
  cellOutputs,
  cellSource,
  createNotebook,
  deriveCellId,
  findCellIndex,
  insertCell,
  mergeRunOutputs,
  moveCell,
  notebookHash,
  notebookKernel,
  notebookOrigin,
  parseNotebook,
  removeCell,
  replaceSource,
  selectCellIndices,
  serializeNotebook,
  setCellMetadata,
  setNotebookMetadata,
  splitLines,
} from "../../src/provider/notebooks/model.js"
import { screenSecrets, WITHHELD } from "../../src/redact.js"

const bytes = (text: string) => Buffer.from(text, "utf8")
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

/** A 4.0–4.4 notebook as nbformat writes one: no ids, sources split into lines. */
const v44 = `{"cells":[{"cell_type":"code","execution_count":2,"metadata":{},"outputs":[{"name":"stdout","output_type":"stream","text":["ok\\n"]}],"source":["print(1)\\n"]},{"cell_type":"markdown","metadata":{},"source":["# Title\\n","two\\n"]}],"metadata":{"kernelspec":{"display_name":"Python 3","language":"python","name":"python3"}},"nbformat":4,"nbformat_minor":4}`

/** A 4.5 notebook with explicit ids, an odd layout and a trailing newline: nothing may reformat it. */
const v45 = `{
 "cells": [
  {
   "cell_type": "code",
   "execution_count": null,
   "id": "abc-123_X",
   "metadata": {},
   "outputs": [],
   "source": "print('hi')"
  }
 ],
 "metadata": {},
 "nbformat": 4,
 "nbformat_minor": 5
}
`

describe("nbformat 4", () => {
  it("round-trips 4.0–4.5 byte for byte when nothing changed", () => {
    for (const minor of [0, 1, 2, 3, 4]) {
      const raw = bytes(minor === 4 ? v44 : v44.replace('"nbformat_minor":4', `"nbformat_minor":${minor}`))
      expect(serializeNotebook(parseNotebook(raw)), `4.${minor}`).toEqual(raw)
    }
    expect(serializeNotebook(parseNotebook(bytes(v45)))).toEqual(bytes(v45))
  })

  it("derives a missing id from the index and source, keeps it for the model's life, and no read writes", () => {
    const raw = bytes(v44)
    const notebook = parseNotebook(raw)
    expect(notebook.cells.map((cell) => cell.id)).toEqual([deriveCellId(0, "print(1)\n"), deriveCellId(1, "# Title\ntwo\n")])
    expect(notebook.cells.every((cell) => cell.derived)).toBe(true)
    // A second parse of the same bytes derives the same ids.
    expect(parseNotebook(raw).cells[0]!.id).toBe(notebook.cells[0]!.id)
    // A read never writes: the bytes come back untouched, so no id reaches the file.
    expect(serializeNotebook(notebook)).toEqual(raw)
    expect(notebook.changed).toBe(false)
    // Inserting in front does not change the ids already handed out in this model.
    const first = notebook.cells[0]!.id
    insertCell(notebook, 0, { type: "raw", source: "x" })
    expect(findCellIndex(notebook, first)).toBe(1)
    expect(notebook.cells[1]!.id).toBe(first)
  })

  it("refuses something that is not nbformat 4 with NOTEBOOK_INVALID", () => {
    for (const raw of ["not json", "[]", '{"nbformat":3,"nbformat_minor":0,"metadata":{},"cells":[]}', '{"nbformat":4,"nbformat_minor":9,"metadata":{},"cells":[]}', '{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[{"cell_type":"code","id":"a","metadata":{},"source":"x","outputs":"no"}]}', '{"nbformat":4,"nbformat_minor":5,"metadata":{},"cells":[{"cell_type":"code","id":"!!!","metadata":{},"source":"x","outputs":[],"execution_count":null}]}']) {
      expect(() => parseNotebook(bytes(raw)), raw).toThrow(/^NOTEBOOK_INVALID: /)
    }
  })

  it("joins split cell sources and text mime values on read, and splits them again on write", () => {
    const notebook = parseNotebook(bytes(v44))
    expect(cellSource(notebook.cells[0]!)).toBe("print(1)\n")
    expect(cellOutputs(notebook.cells[0]!)[0]!.text).toBe("ok\n")

    replaceSource(notebook, 0, "print(2)\n")
    const written = JSON.parse(decode(serializeNotebook(notebook))) as {
      cells: { source: string[]; outputs: { text: string[] }[] }[]
    }
    expect(written.cells[0]!.source).toEqual(["print(2)\n"])
    expect(written.cells[0]!.outputs[0]!.text).toEqual(["ok\n"])
    // Read back, they are strings again.
    const reread = parseNotebook(serializeNotebook(notebook))
    expect(cellSource(reread.cells[0]!)).toBe("print(2)\n")
    expect(cellOutputs(reread.cells[0]!)[0]!.text).toBe("ok\n")
  })

  it("persists the derived ids and raises nbformat_minor to 5 when colab_edit saves", () => {
    const notebook = parseNotebook(bytes(v44))
    replaceSource(notebook, 0, "print(3)\n")
    const written = serializeNotebook(notebook)
    const document = JSON.parse(decode(written)) as { nbformat_minor: number; cells: { id: string }[] }
    expect(document.nbformat_minor).toBe(5)
    expect(document.cells.map((cell) => cell.id)).toHaveLength(2)
    expect(document.cells[0]!.id).toBe(notebook.cells[0]!.id)
    // The file reads back with those ids, not derived ones.
    expect(parseNotebook(written).cells.every((cell) => !cell.derived)).toBe(true)
  })

  it("leaves the minor and the ids alone for the copy a push uploads", () => {
    const notebook = parseNotebook(bytes(v44))
    replaceSource(notebook, 0, "print(4)\n")
    const document = JSON.parse(decode(serializeNotebook(notebook, { persistIds: false }))) as { nbformat_minor: number; cells: { id?: string }[] }
    expect(document.nbformat_minor).toBe(4)
    expect(document.cells.every((cell) => cell.id === undefined)).toBe(true)
  })

  it("strips nbformat's transient metadata keys on write", () => {
    const raw = `{"cells":[{"cell_type":"code","execution_count":null,"metadata":{"trusted":true},"outputs":[],"source":"x"}],"metadata":{"signature":"abc","orig_nbformat":4},"nbformat":4,"nbformat_minor":5}`
    const notebook = parseNotebook(bytes(raw))
    replaceSource(notebook, 0, "y")
    const document = JSON.parse(decode(serializeNotebook(notebook))) as { metadata: Record<string, unknown>; cells: { metadata: Record<string, unknown> }[] }
    expect(document.metadata).toEqual({})
    expect(document.cells[0]!.metadata).toEqual({})
  })

  it("applies every cell operation, and addresses cells by index and by id", () => {
    const notebook = createNotebook({ kernel: "python3", cells: [{ type: "code", source: "a" }, { type: "markdown", source: "b" }] })
    expect(notebookKernel(notebook)).toEqual({ name: "python3" })
    const second = notebook.cells[1]!.id

    insertCell(notebook, 1, { type: "raw", source: "c" })
    expect(notebook.cells.map(cellSource)).toEqual(["a", "c", "b"])
    moveCell(notebook, 0, 2)
    expect(notebook.cells.map(cellSource)).toEqual(["c", "b", "a"])
    expect(findCellIndex(notebook, second)).toBe(1)
    removeCell(notebook, 0)
    expect(notebook.cells.map(cellSource)).toEqual(["b", "a"])
    moveCell(notebook, 0, notebook.cells.length)
    expect(notebook.cells.map(cellSource)).toEqual(["a", "b"])
    expect(selectCellIndices(notebook, "all")).toEqual([0, 1])
    expect(selectCellIndices(notebook, [second])).toEqual([1])
    expect(selectCellIndices(notebook, { from: 0, to: 1 })).toEqual([0, 1])
    expect(() => selectCellIndices(notebook, { from: 1, to: 0 })).toThrow(/^INPUT_INVALID: /)
    expect(() => findCellIndex(notebook, "missing")).toThrow(/^NOT_FOUND: /)

    setNotebookMetadata(notebook, { colab_origin: "someone@example.com" })
    expect(notebookOrigin(notebook)).toBe("someone@example.com")
    setCellMetadata(notebook, 0, { tags: ["keep"] })
    expect(notebook.cells[0]!.json.metadata).toEqual({ tags: ["keep"] })
  })

  it("does not mark a notebook changed when an operation sets what it already had", () => {
    const notebook = createNotebook({ cells: [{ type: "code", source: "a" }] })
    setCellMetadata(notebook, 0, { tags: ["keep"] })
    notebook.changed = false
    replaceSource(notebook, 0, "a")
    setCellMetadata(notebook, 0, { tags: ["keep"] })
    expect(notebook.changed).toBe(false)
  })

  it("splits lines as nbformat's splitlines(True) does", () => {
    expect(splitLines("a\nb\r\nc\rd")).toEqual(["a\n", "b\r\n", "c\r", "d"])
    expect(splitLines("")).toEqual([])
    expect(splitLines("a\n")).toEqual(["a\n"])
  })

  it("hands out a unique id when two inserts at one index would derive the same one", () => {
    const notebook = createNotebook({})
    insertCell(notebook, 0, { type: "raw", source: "same" })
    insertCell(notebook, 0, { type: "raw", source: "same" })
    expect(new Set(notebook.cells.map((cell) => cell.id)).size).toBe(2)
    const written = decode(serializeNotebook(notebook))
    const ids = (JSON.parse(written) as { cells: { id: string }[] }).cells.map((cell) => cell.id)
    expect(new Set(ids).size).toBe(2)
  })

  it("merges a run's outputs by cell id, and writes nothing when a run cell changed", () => {
    const notebook = parseNotebook(bytes(v45))
    const id = notebook.cells[0]!.id
    mergeRunOutputs(notebook, [{ id, source: "print('hi')", outputs: [{ output_type: "stream", name: "stdout", text: "hi\n" }], executionCount: 7 }], ".colab/runs/r1")
    expect(cellOutputs(notebook.cells[0]!)[0]!.text).toBe("hi\n")
    expect(cellExecutionCount(notebook.cells[0]!)).toBe(7)
    expect(notebook.changed).toBe(true)

    const later = parseNotebook(bytes(v45))
    let failure: ColabError | undefined
    try {
      // A valid first cell and a changed second one: the whole merge is refused and the model stays untouched.
      mergeRunOutputs(later, [{ id, source: "print('hi')", outputs: [{ output_type: "stream", name: "stdout", text: "x" }], executionCount: 8 }, { id: "missing", source: "x", outputs: [], executionCount: 1 }], ".colab/runs/r2")
    } catch (error) {
      failure = error as ColabError
    }
    expect(failure?.code).toBe("NOTEBOOK_CHANGED")
    expect(failure?.next).toContain(".colab/runs/r2")
    expect(later.changed).toBe(false)
    expect(later.cells[0]!.json.execution_count).toBeNull()
  })

  it("hashes the file's bytes as sha256:<hex>", () => {
    expect(notebookHash(bytes("x"))).toBe("sha256:2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881")
  })
})

describe("the source secret screen", () => {
  it("withholds Google, AWS, PEM, bearer and assigned secrets", () => {
    const samples = [
      "key = 'AIzaSyA1234567890abcdefghijklmnopqrstuv'",
      "aws = AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
      "headers = {'Authorization': 'Bearer abcdefghijklmnop'}",
      'password: "hunter2hunter2"',
      "token = 'ghp_abcdefghijklmnopqrstuvwxyz'",
    ]
    for (const sample of samples) {
      const screened = screenSecrets(sample)
      expect(screened.matches, sample).toBeGreaterThan(0)
      expect(screened.text, sample).toContain(WITHHELD)
    }
  })

  it("withholds the family's long key run, hex included, and spares only sha256:<hex> (review M3)", () => {
    const hex = "0123456789abcdef0123456789abcdef01234567"
    // A 40-hex Weights & Biases key in the two everyday Colab forms.
    expect(screenSecrets(`wandb.login(key="${hex}")`).matches).toBeGreaterThan(0)
    expect(screenSecrets(`os.environ["WANDB_API_KEY"] = "${hex}"`).matches).toBeGreaterThan(0)
    // A Hugging Face token.
    expect(screenSecrets('login("hf_AbCdEfGhIjKlMnOpQrStUvWxYz01234567")').matches).toBeGreaterThan(0)
    // A bare 64-hex checksum is withheld too.
    const checksum = "digest = '5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'"
    expect(screenSecrets(checksum).matches).toBeGreaterThan(0)
    // The plugin's own hash form is the one exemption.
    const own = "hash = 'sha256:5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8'"
    expect(screenSecrets(own)).toEqual({ text: own, matches: 0, found: false, kinds: [] })
    const code = "values = [1, 2, 3]\nprint(sum(values))\n"
    expect(screenSecrets(code)).toEqual({ text: code, matches: 0, found: false, kinds: [] })
  })
})
