// Package C's must-prove items "Drive pull/push, sync records, pushOutputs" (design §5, §7.2, §7.5, §15.1) and the
// Drive half of L8/L8b: pull refuses over local edits, the four sync states, pushOutputs strips by default (Q10), the
// secret note comes first in a preview, the replaced revision is pinned and the 200 cap reports REVISION_PIN_SKIPPED,
// and a commit re-reads the local hash, the Drive head and the sync record.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PortEnv } from "../../src/provider/index.js"
import { PLAN_ACTIONS } from "../../src/domain/actions.js"
import { ColabError } from "../../src/domain/errors.js"
import { notebookHash, parseNotebook } from "../../src/provider/notebooks/model.js"
import { resolveWorkspacePath } from "../../src/provider/notebooks/paths.js"
import { createDriveSync, safeName } from "../../src/provider/notebooks/pull.js"
import { readSyncRecord, syncState } from "../../src/provider/notebooks/sync.js"
import { toolHandlers } from "../support/legacy.js"
import { runTool, type Runner } from "../support/legacy.js"
import { fakeDeps, type Fakes, RecordingPermission } from "../fakes/index.js"
import { invented } from "../support/invented.js"

const call = (id = "call_1") => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id, signal: new AbortController().signal })
const source = `key = '${invented("AIza", "SyA1234567890abcdefghijklmnopqrstuv")}'\nprint(1)\n`
const fixture = (): string =>
  JSON.stringify(
    {
      cells: [{ cell_type: "code", execution_count: 3, id: "c1", metadata: {}, outputs: [{ name: "stdout", output_type: "stream", text: "1\n" }], source }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    1,
  )

let directory: string
let runner: Runner
let permission: RecordingPermission
let fakes: Fakes
let deps: ReturnType<typeof fakeDeps>["deps"]

function setup(options: unknown = {}): void {
  const made = fakeDeps({ options, directory })
  deps = made.deps
  fakes = made.fakes
  permission = new RecordingPermission()
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
}

const env = (): PortEnv => ({ options: deps.options, directory: deps.directory, clock: deps.clock, auth: deps.auth, ledger: deps.ledger, fetch: (() => Promise.reject(new Error("tests never reach the network"))) as unknown as typeof fetch })
const driveSync = () => createDriveSync(env(), fakes.drive)
/** The provider-read callback the pull takes; the unit test records nothing through it. */
const read = async () => undefined

function seedDrive(input: { readonly id?: string; readonly name?: string; readonly head?: string; readonly bytes?: string; readonly ownedByMe?: boolean } = {}): string {
  const id = input.id ?? "f1"
  const bytes = Buffer.from(input.bytes ?? fixture())
  fakes.drive.files.set(id, { file: { id, name: input.name ?? "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: input.head ?? "rev-1", modifiedTime: "2026-11-17T09:00:00.000Z", ownedByMe: input.ownedByMe ?? true }, bytes })
  return id
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "colab-notebooks-drive-"))
  setup()
})
afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

const write = (path: string, text: string) => writeFileSync(join(directory, path), text)

describe("the Drive pull", () => {
  it("downloads to workDir/files by default and writes the sync record after the rename", async () => {
    seedDrive()
    const result = (await driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)) as { state: string; path: string; bytes: number; sha256: string }
    expect(result.state).toBe("ok")
    expect(result.path).toBe(".colab/files/analysis.ipynb")
    expect(result.bytes).toBe(Buffer.byteLength(fixture()))
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(readFileSync(join(directory, ".colab/files/analysis.ipynb")).toString("utf8")).toBe(fixture())
    const target = await resolveWorkspacePath(".colab/files/analysis.ipynb", { directory, allowedRoots: [] })
    expect(await readSyncRecord(target, deps.directory, deps.options.workDir)).toEqual({ fileId: "f1", baseRevision: "rev-1", baseHash: notebookHash(Buffer.from(fixture())) })
  })

  it("needs overwrite for an existing file and refuses LOCAL_CHANGED over unpushed edits even with it", async () => {
    seedDrive()
    await driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)
    const again = await Promise.resolve(driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)).catch((error: unknown) => error)
    expect(again).toMatchObject({ code: "FILE_EXISTS" })

    writeFileSync(join(directory, ".colab/files/analysis.ipynb"), fixture().replace('print(1)\\n', 'print(2)\\n'))
    const refused = await Promise.resolve(driveSync().pull("default", { drive: "f1", overwrite: true }, new AbortController().signal, read)).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "LOCAL_CHANGED" })
  })

  it("refuses a Drive file that is not an nbformat 4 notebook", async () => {
    seedDrive({ bytes: "not a notebook" })
    const refused = await Promise.resolve(driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)).catch((error: unknown) => error)
    expect(refused).toMatchObject({ code: "NOTEBOOK_INVALID" })
  })

  it("makes a Drive file name safe for the workspace and keeps .ipynb", () => {
    expect(safeName("analysis.ipynb")).toBe("analysis.ipynb")
    expect(safeName("a/b")).toBe("a-b.ipynb")
    expect(safeName("...")).toBe("notebook.ipynb")
    expect(safeName("x".repeat(200))).toHaveLength(120)
    expect(safeName("x".repeat(200)).endsWith(".ipynb")).toBe(true)
  })

  it("refuses Drive on an enterprise account that did not opt into drive.file", async () => {
    setup({ accounts: { ent: { access: "write", backend: "enterprise", project: "p", region: "us-central1", outputBucket: "gs://bucket/out" } } })
    expect(await runTool("plan", { account: "ent", action: "drive.create", params: { path: "missing.ipynb" } }, call(), runner)).toMatchObject({ state: "refused", error: "AUTH_SCOPE_MISSING" })
    const pulled = await Promise.resolve(driveSync().pull("ent", { drive: "f1" }, new AbortController().signal, read)).catch((error: unknown) => error)
    expect(pulled).toMatchObject({ code: "AUTH_SCOPE_MISSING" })
  })

  it("names the four sync states, and none without a record", () => {
    const record = { fileId: "f1", baseRevision: "rev-1", baseHash: "sha256:a" }
    expect(syncState(undefined, "sha256:a", "rev-1")).toBe("none")
    expect(syncState(record, "sha256:a", "rev-1")).toBe("clean")
    expect(syncState(record, "sha256:b", "rev-1")).toBe("local-changed")
    expect(syncState(record, "sha256:a", "rev-2")).toBe("drive-changed")
    expect(syncState(record, "sha256:b", "rev-2")).toBe("both")
    expect(syncState(record, "sha256:a", undefined)).toBe("drive-changed")
  })
})

describe("drive.create", () => {
  it("previews the secret-shaped sources first, strips outputs by default (Q10), and uploads the stripped notebook", async () => {
    write("analysis.ipynb", fixture())
    const planned = (await runTool("plan", { action: "drive.create", params: { path: "analysis.ipynb" } }, call(), runner)) as { state: string; planId: string; category: string; preview: Record<string, unknown> }
    expect(planned.state).toBe("ok")
    expect(planned.category).toBe("write")
    expect(Object.keys(planned.preview)[0]).toBe("secretShaped")
    expect(String(planned.preview.secretShaped)).toContain("stripping outputs does not strip sources")
    expect(planned.preview).toMatchObject({
      name: "analysis.ipynb",
      path: "analysis.ipynb",
      cells: 1,
      outputs: "strip",
      revisions: "A new file: no revision is replaced.",
      driveId: "generated-1",
      colab: "If the notebook is open in Colab, Colab's autosave may overwrite this push.",
      trust: "untrusted",
    })
    expect(planned.preview.hash).toBe(notebookHash(readFileSync(join(directory, "analysis.ipynb"))))

    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: { fileId: string; outputs: string; name: string; trust: string } }
    expect(committed.state).toBe("ok")
    expect(committed.result).toMatchObject({ fileId: "generated-1", outputs: "strip", name: "analysis.ipynb", trust: "untrusted" })
    const uploaded = parseNotebook(fakes.drive.files.get("generated-1")!.bytes)
    expect(uploaded.cells[0]!.json.outputs).toEqual([])
    expect(uploaded.cells[0]!.json.execution_count).toBeNull()
    expect(uploaded.cells[0]!.json.source).toBe(source)
    // The local file keeps its outputs; the sync record names the new file.
    expect(parseNotebook(readFileSync(join(directory, "analysis.ipynb"))).cells[0]!.json.outputs).toHaveLength(1)
    const target = await resolveWorkspacePath("analysis.ipynb", { directory, allowedRoots: [] })
    expect(await readSyncRecord(target, deps.directory, deps.options.workDir)).toMatchObject({ fileId: "generated-1", baseRevision: "rev-1" })
    // A change commit asserts colab.write (the route) and no colab.read for create/update; the one read is the
    // preview's files.generateIds.
    expect(permission.requests.map((request) => request.action)).toEqual(["colab.plan", "colab.read", "colab.write"])
  })

  it("keeps outputs when the option says keep", async () => {
    setup({ pushOutputs: "keep" })
    write("analysis.ipynb", fixture())
    const planned = (await runTool("plan", { action: "drive.create", params: { path: "analysis.ipynb", name: "renamed" } }, call(), runner)) as { planId: string; preview: Record<string, unknown> }
    expect(planned.preview).toMatchObject({ outputs: "keep", name: "renamed.ipynb" })
    await runTool("write", { planId: planned.planId }, call(), runner)
    const uploaded = parseNotebook(fakes.drive.files.get("generated-1")!.bytes)
    expect(uploaded.cells[0]!.json.outputs).toHaveLength(1)
    expect(uploaded.cells[0]!.json.execution_count).toBe(3)
  })

  it("refuses a push over maxUploadBytes at preview, before anything is planned", async () => {
    setup({ maxUploadBytes: "1MiB" })
    const big = JSON.stringify({
      cells: Array.from({ length: 27 }, (_, index) => ({ cell_type: "code", execution_count: null, id: `c${index}`, metadata: {}, outputs: [], source: "x".repeat(200_000) })),
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    })
    expect(Buffer.byteLength(big)).toBeGreaterThan(1024 * 1024)
    write("big.ipynb", big)
    expect(await runTool("plan", { action: "drive.create", params: { path: "big.ipynb" } }, call(), runner)).toMatchObject({ state: "refused", error: "FILE_TOO_LARGE" })
    expect(fakes.drive.files.size).toBe(0)
  })

  it("refuses a second create for a notebook that already has a sync record", async () => {
    seedDrive()
    await driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)
    const result = await runTool("plan", { action: "drive.create", params: { path: ".colab/files/analysis.ipynb" } }, call(), runner)
    expect(result).toMatchObject({ state: "refused", error: "FILE_EXISTS" })
  })

  it("joins the pre-generated id when the answer was lost, and says UNCERTAIN when the file is not there", async () => {
    write("analysis.ipynb", fixture())
    const planned = (await runTool("plan", { action: "drive.create", params: { path: "analysis.ipynb" } }, call(), runner)) as { planId: string }
    // Drive made the file, but the create's answer was lost; the fixed id finds it.
    fakes.drive.files.set("generated-1", { file: { id: "generated-1", name: "analysis.ipynb", mimeType: "application/vnd.google.colaboratory", headRevisionId: "rev-1", ownedByMe: true }, bytes: Buffer.from(fixture()) })
    fakes.drive.create = async () => {
      throw new ColabError("UNAVAILABLE", "Drive's upload did not complete.")
    }
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: { fileId: string; joined: boolean } }
    expect(committed.state).toBe("ok")
    expect(committed.result).toMatchObject({ fileId: "generated-1", joined: true })

    write("other.ipynb", fixture())
    const second = (await runTool("plan", { action: "drive.create", params: { path: "other.ipynb" } }, call(), runner)) as { planId: string }
    fakes.drive.files.clear()
    expect(await runTool("write", { planId: second.planId }, call(), runner)).toMatchObject({ state: "failed", error: "UNCERTAIN" })
  })

  it("answers PLAN_CHANGED when the local notebook changed after the preview", async () => {
    write("analysis.ipynb", fixture())
    const planned = (await runTool("plan", { action: "drive.create", params: { path: "analysis.ipynb" } }, call(), runner)) as { planId: string }
    write("analysis.ipynb", fixture().replace("print(1)", "print(9)"))
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "refused", error: "PLAN_CHANGED" })
    expect(fakes.drive.files.size).toBe(0)
  })
})

describe("drive.update", () => {
  async function pulled(): Promise<string> {
    seedDrive()
    await driveSync().pull("default", { drive: "f1" }, new AbortController().signal, read)
    return ".colab/files/analysis.ipynb"
  }

  it("previews the base and head revisions, the pin note and the Colab autosave note, then replaces and pins the revision", async () => {
    const path = await pulled()
    const planned = (await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)) as { state: string; planId: string; preview: Record<string, unknown> }
    expect(planned.state).toBe("ok")
    expect(planned.preview).toMatchObject({
      drive: "f1",
      baseRevision: "rev-1",
      headRevision: "rev-1",
      outputs: "strip",
      colab: "If the notebook is open in Colab, Colab's autosave may overwrite this push.",
    })
    expect(String(planned.preview.revisions)).toContain("keepForever")
    expect(String(planned.preview.revisions)).toContain("REVISION_PIN_SKIPPED")

    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { result: { fileId: string; replacedRevision: string; pinned: boolean; revision: string } }
    expect(committed.result).toMatchObject({ fileId: "f1", replacedRevision: "rev-1", pinned: true })
    expect(fakes.drive.calls.some((entry) => entry.method === "keepRevision" && entry.args[2] === "rev-1")).toBe(true)
    expect(fakes.drive.files.get("f1")!.file.headRevisionId).not.toBe("rev-1")
    const target = await resolveWorkspacePath(path, { directory, allowedRoots: [] })
    expect((await readSyncRecord(target, deps.directory, deps.options.workDir))!.baseRevision).toBe(fakes.drive.files.get("f1")!.file.headRevisionId)
  })

  it("says not pinned at preview and skips the pin when the file already keeps 200 revisions", async () => {
    const path = await pulled()
    fakes.drive.kept.set("f1", 200)
    const planned = (await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)) as { planId: string; preview: Record<string, unknown> }
    expect(planned.preview).toMatchObject({ pin: false })
    expect(String(planned.preview.revisions)).toContain("not pinned")
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: { pinned: boolean; pinFailure?: string; warnings?: string[] }; warnings?: string[] }
    expect(committed.state).toBe("ok")
    expect(committed.result).toMatchObject({ pinned: false, pinFailure: "cap" })
    expect(committed.result.warnings ?? committed.warnings).toContain("REVISION_PIN_SKIPPED")
    expect(fakes.drive.calls.some((entry) => entry.method === "keepRevision")).toBe(false)
  })

  it("refuses DRIVE_CONFLICT when Drive's head moved after the pull", async () => {
    const path = await pulled()
    fakes.drive.files.set("f1", { ...fakes.drive.files.get("f1")!, file: { ...fakes.drive.files.get("f1")!.file, headRevisionId: "rev-2" } })
    const result = await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)
    expect(result).toMatchObject({ state: "refused", error: "DRIVE_CONFLICT" })
  })

  it("reports a push that landed with a failed pin, and the next plan is not a conflict (review probe P2)", async () => {
    const path = await pulled()
    fakes.drive.keepRevision = async () => {
      throw new ColabError("UNAVAILABLE", "Drive refused the call (HTTP 503).")
    }
    const planned = (await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)) as { planId: string }
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: { landed: boolean; pinned: boolean; pinFailure?: string; warnings?: string[] } }
    expect(committed.state).toBe("ok")
    expect(committed.result).toMatchObject({ landed: true, pinned: false, pinFailure: "error" })
    expect(committed.result.warnings).toContain("REVISION_PIN_SKIPPED")
    // The bytes landed, and the record already names the new head: a retry plans cleanly.
    const target = await resolveWorkspacePath(path, { directory, allowedRoots: [] })
    const record = await readSyncRecord(target, deps.directory, deps.options.workDir)
    expect(record!.baseRevision).toBe(fakes.drive.files.get("f1")!.file.headRevisionId)
    expect(await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)).toMatchObject({ state: "ok" })
  })

  it("answers PLAN_CHANGED when Drive moved between the preview and the commit", async () => {
    const path = await pulled()
    const planned = (await runTool("plan", { action: "drive.update", params: { path } }, call(), runner)) as { planId: string }
    fakes.drive.files.set("f1", { ...fakes.drive.files.get("f1")!, file: { ...fakes.drive.files.get("f1")!.file, headRevisionId: "rev-2" } })
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "refused", error: "PLAN_CHANGED" })
  })

  it("needs a sync record, and says how to make one", async () => {
    write("analysis.ipynb", fixture())
    const result = await runTool("plan", { action: "drive.update", params: { path: "analysis.ipynb" } }, call(), runner)
    expect(result).toMatchObject({ state: "refused", error: "NOT_FOUND" })
    expect((result as { next: string }).next).toContain("drive.create")
  })
})

describe("drive.trash", () => {
  it("previews the file, then trashes it on commit (a delete plan)", async () => {
    seedDrive()
    const planned = (await runTool("plan", { action: "drive.trash", params: { drive: "f1" } }, call(), runner)) as { planId: string; category: string; commit: string; preview: Record<string, unknown> }
    expect(planned.category).toBe("delete")
    expect(planned.commit).toBe("colab_delete")
    expect(planned.preview).toMatchObject({ drive: "f1", name: "analysis.ipynb", trust: "untrusted" })
    expect(String(planned.preview.restorable)).toContain("restored from Drive")

    expect(await runTool("delete", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "ok", result: { drive: "f1", trashed: true } })
    expect(fakes.drive.calls.some((entry) => entry.method === "update" && (entry.args[2] as { trashed?: boolean }).trashed === true)).toBe(true)
  })

  it("answers PLAN_CHANGED when the file is gone at commit", async () => {
    seedDrive()
    const planned = (await runTool("plan", { action: "drive.trash", params: { drive: "f1" } }, call(), runner)) as { planId: string }
    fakes.drive.files.delete("f1")
    expect(await runTool("delete", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "refused", error: "PLAN_CHANGED" })
  })
})

describe("the plans as declared", () => {
  it("has a Drive handler for both backends of every Drive action", async () => {
    for (const action of ["drive.create", "drive.update", "drive.trash"] as const) {
      expect(PLAN_ACTIONS[action].backends).toEqual({ colab: expect.anything(), enterprise: expect.anything() })
      setup({ accounts: { ent: { access: "write", backend: "enterprise", drive: true, project: "p", region: "us-central1", outputBucket: "gs://bucket/out" } } })
      const params = action === "drive.trash" ? { drive: "missing" } : { path: "missing.ipynb" }
      const result = await runTool("plan", { account: "ent", action, params }, call(), runner)
      // The enterprise account reaches the same handler: the failure is about the target, never ACTION_UNSUPPORTED.
      expect({ action, ...(result as object) }).toMatchObject({ action, state: "refused", error: "NOT_FOUND" })
    }
  })
})
