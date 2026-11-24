import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import * as z from "zod"
import { TOOLS } from "../../src/domain/actions.js"
import { contracts } from "../../src/editing/contract.js"
import { localFileRequests } from "../../src/editing/file-permissions.js"
import { loadEditingOptions } from "../../src/editing/options.js"
import { verifyLocalSession } from "../../src/editing/plugin.js"
import { buildEditingTool, editEffect, editingDefaults, editingMethods, guardedAssert, hasBroaderEditEffect, runEditingTool, surfaceRules, SURFACE_TOOLS, type Runner } from "../../src/editing/tools.js"
import { isSupportedWriteFilesystem, supportsBoundWrites } from "../../src/editing/write.js"
import { notebookHash } from "../../src/notebooks/model.js"
import { loadOptions } from "../../src/options.js"
import type { Assert } from "../../src/ports.js"

const call = { sessionID: "ses_fixture", agent: "build", messageID: "msg_fixture", id: "call_fixture", signal: new AbortController().signal }
const dirs: string[] = []
async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "colab-editing-")))
  dirs.push(directory)
  const assert = vi.fn<Assert>(async () => undefined)
  const verify = vi.fn<Runner["verify"]>(async () => undefined)
  return { directory, options: loadEditingOptions({}), assert, verify } satisfies Runner
}
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

it("registers exactly three local strict schemas and only two Code Mode tools and RPC reads", async () => {
  const runner = await setup()
  expect(Object.keys(contracts)).toEqual(["find", "notebook", "edit"])
  expect(SURFACE_TOOLS.map((entry) => buildEditingTool(entry, runner).options.codemode)).toEqual([true, true, false])
  const methods = editingMethods(runner)
  expect(methods.map(({ name, class: cls }) => [name, cls])).toEqual([["find", "read"], ["notebook", "read"]])
  for (const contract of Object.values(contracts)) {
    expect(contract.description).not.toMatch(/Drive|GCS|runtime|Enterprise/)
    expect(z.toJSONSchema(contract.input, { io: "output" })).toMatchObject({ additionalProperties: false })
    const schema = z.toJSONSchema(contract.output)
    expect(schema).toHaveProperty("anyOf")
    expect(JSON.stringify(schema)).not.toMatch(/AUTH_REQUIRED|ACCOUNT_UNKNOWN|FOREIGN_NOTEBOOK|RUNTIME_|DRIVE_|GCS/)
  }
  expect(await methods[0]!.run({}, call as never)).toMatchObject({ state: "ok", notebooks: [] })
  expect(await methods[0]!.run({ where: "gcs" }, call as never)).toMatchObject({ error: "EXECUTION_UNAVAILABLE" })
})

it("refuses every latent tool, cloud reference and unsupported identity before permission or dispatch", async () => {
  const runner = await setup()
  const names = new Set<string>(Object.keys(contracts))
  for (const { name } of TOOLS) {
    if (names.has(name)) continue
    expect(await runEditingTool(name, {}, call, runner)).toMatchObject({ state: "refused", error: "EXECUTION_UNAVAILABLE" })
  }
  for (const [name, input] of [
    ["find", { where: "drive" }], ["find", { where: "gcs" }], ["find", { account: "example" }],
    ["notebook", { notebook: { drive: "example" } }], ["notebook", { notebook: { gcs: "example" } }],
    ["notebook", { notebook: { run: "example" } }], ["edit", { account: "example" }],
  ] as const) expect(await runEditingTool(name, input, call, runner)).toMatchObject({ state: "refused", error: "EXECUTION_UNAVAILABLE" })
  for (const [name, input] of [
    ["find", { limit: 201 }], ["find", { pattern: "" }], ["notebook", { notebook: {} }],
    ["edit", { path: "example.ipynb", ops: [{ op: "replace", cell: 0, source: "example" }] }],
    ["edit", { path: "example.ipynb", ops: [{ op: "create" }, { op: "create" }] }],
  ] as const) expect(await runEditingTool(name, input, call, runner)).toMatchObject({ error: "INPUT_INVALID" })
  expect(runner.verify).not.toHaveBeenCalled()
  expect(runner.assert).not.toHaveBeenCalled()
})

it("binds a local call to its host session, project, workspace and agent", () => {
  const location = { directory: "/sample/work", workspaceID: "workspace", project: { id: "project" } }
  const session = { id: call.sessionID, agent: call.agent, location, projectID: "project" }
  expect(verifyLocalSession(location, call.sessionID, session, call.agent)).toBe(session)
  for (const different of [
    { ...session, id: "different" }, { ...session, agent: "reviewer" }, { ...session, projectID: "different" },
    { ...session, location: { ...location, workspaceID: "different" } }, { ...session, location: { ...location, directory: "/sample/other" } },
  ]) expect(() => verifyLocalSession(location, call.sessionID, different, call.agent)).toThrow(/INPUT_INVALID/)
})

it("the editing permission bridge only forwards local tool and host-file actions", async () => {
  const host = vi.fn<Assert>(async () => undefined)
  const assert = guardedAssert(host)
  const request = { ...call, resources: ["default"], metadata: {}, source: { type: "tool" as const, messageID: call.messageID, id: call.id } }
  for (const action of ["colab.read", "colab.probe", "colab.cleanup", "colab.run"]) {
    await expect(assert({ ...request, action })).rejects.toMatchObject({ code: "EXECUTION_UNAVAILABLE" })
  }
  expect(host).not.toHaveBeenCalled()
  for (const action of ["colab.find", "colab.notebook", "colab.edit", "edit", "read", "external_directory"]) {
    await assert({ ...request, action })
  }
  expect(host.mock.calls.map(([entry]) => entry.action)).toEqual(["colab.find", "colab.notebook", "colab.edit", "edit", "read", "external_directory"])
})
it("accepts only local options; provider options name the refused field", () => {
  const local = loadEditingOptions({ access: "ask-changes", maxInlineBytes: "1MiB", maxDownloadBytes: 400, allowedRoots: ["data"], workDir: ".local", ledgerDays: 2, allowUntestedHost: true })
  expect(local).toEqual({ access: "ask-changes", maxInlineBytes: 1024 ** 2, maxDownloadBytes: 400, allowedRoots: ["data"], workDir: ".local", ledgerDays: 2, allowUntestedHost: true })
  const keys = new Set([...Object.keys(loadOptions({})), "oauthClient", "redirectUri", "callbackPort", "rates", "acess"])
  for (const key of [...keys].filter((key) => !Object.hasOwn(local, key))) {
    expect(() => loadEditingOptions({ [key]: true })).toThrow(new RegExp(`OPTIONS_INVALID:.*${key}.*Remove`))
  }
})

it("creates, finds, reads and edits a notebook locally, without fetch and with one plugin assertion per tool", async () => {
  const runner = await setup()
  const fetch = vi.fn(() => { throw new Error("unexpected network") })
  vi.stubGlobal("fetch", fetch)
  const run = (name: string, input: unknown) => runEditingTool(name, input, call, runner)
  const path = "nested/example.ipynb"
  await mkdir(join(runner.directory, "nested"))
  const created = await run("edit", { path, ops: [{ op: "create", cells: [{ type: "markdown", source: "before" }] }] })
  if (process.platform !== "linux") {
    expect(created).toMatchObject({ error: "EDIT_UNAVAILABLE" })
    expect(await readdir(join(runner.directory, "nested"))).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
    return
  }
  expect(created).toMatchObject({ state: "ok", cells: 1 })
  const hash = notebookHash(await readFile(join(runner.directory, path)))
  expect(created).toMatchObject({ hash })
  expect(await run("find", { pattern: "nested/*.ipynb" })).toMatchObject({ notebooks: [{ where: "workspace", path }] })
  expect(await run("notebook", { notebook: { path }, outputs: "none" })).toMatchObject({ hash, trust: "untrusted", cells: [{ source: "before" }] })
  const changed = await run("edit", { path, ifHash: hash, ops: [{ op: "replace", cell: 0, source: "after" }] })
  expect(changed).toMatchObject({ hash: notebookHash(await readFile(join(runner.directory, path))) })
  expect(await run("edit", { path, ifHash: hash, ops: [{ op: "replace", cell: 0, source: "stale" }] })).toMatchObject({ error: "NOTEBOOK_CHANGED" })
  expect(await readFile(join(runner.directory, path), "utf8")).toContain('"after"')
  expect(runner.assert.mock.calls.map(([request]) => request.action)).toEqual(["colab.edit", "edit", "colab.find", "colab.notebook", "read", "colab.edit", "edit", "colab.edit", "edit"])
  expect(fetch).not.toHaveBeenCalled()
})

it("requires regular notebook paths, applies byte caps, and preserves host file denials", async () => {
  const runner = await setup()
  const path = "example.ipynb"
  const run = (name: string, input: unknown) => runEditingTool(name, input, call, runner)
  await mkdir(join(runner.directory, "folder.ipynb"))
  expect(await run("notebook", { notebook: { path: "folder.ipynb" } })).toMatchObject({ error: "PATH_REFUSED" })
  expect(await run("notebook", { notebook: { path: "example.txt" } })).toMatchObject({ error: "PATH_REFUSED" })
  await writeFile(join(runner.directory, path), " ".repeat(20))
  await symlink(path, join(runner.directory, "alias.ipynb"))
  expect(await run("notebook", { notebook: { path: "alias.ipynb" } })).toMatchObject({ error: "PATH_REFUSED" })
  expect(await run("find", {})).toMatchObject({ notebooks: [{ path }] })
  expect(await runEditingTool("notebook", { notebook: { path } }, call, { ...runner, options: loadEditingOptions({ maxDownloadBytes: 10 }) })).toMatchObject({ error: "FILE_TOO_LARGE" })
  runner.assert.mockImplementation(async ({ action }) => { if (action === "edit" || action === "read") throw new Error("host deny") })
  await expect(run("notebook", { notebook: { path } })).rejects.toThrow("host deny")
  const edit = run("edit", { path: "new.ipynb", ops: [{ op: "create" }] })
  if (process.platform === "linux") await expect(edit).rejects.toThrow("host deny")
  else expect(await edit).toMatchObject({ error: "EDIT_UNAVAILABLE" })
  await expect(readFile(join(runner.directory, "new.ipynb"))).rejects.toMatchObject({ code: "ENOENT" })
})

it("limits writes to Linux procfs and approved local mounts, without a platform fallback", () => {
  expect(supportsBoundWrites("linux", true, 0x9fa0, 0x9fa0)).toBe(true)
  expect(supportsBoundWrites("darwin", true, 0x9fa0, 0x9fa0)).toBe(false)
  expect(supportsBoundWrites("linux", false, 0x9fa0, 0x9fa0)).toBe(false)
  expect(supportsBoundWrites("linux", true, 0, 0x9fa0)).toBe(false)
  expect(supportsBoundWrites("linux", true, 0x9fa0, 0)).toBe(false)
  expect([0xef53, 0x58465342, 0x9123683e, 0x01021994].every(isSupportedWriteFilesystem)).toBe(true)
  expect([0x9fa0, 0x6969, 0x794c7630].some(isSupportedWriteFilesystem)).toBe(false) // procfs, NFS, overlay
})

it("does not create folders, leave scratch files, change protected content, or clobber an existing create destination", async () => {
  const runner = await setup()
  const path = "existing.ipynb"
  await writeFile(join(runner.directory, path), "existing fixture")
  const create = (path: string) => runEditingTool("edit", { path, ops: [{ op: "create" }] }, call, runner)
  expect(await create(path)).toMatchObject({ error: process.platform === "linux" ? "FILE_EXISTS" : "EDIT_UNAVAILABLE" })
  expect(await create("missing/new.ipynb")).toMatchObject({ error: "EDIT_UNAVAILABLE" })
  expect(await readFile(join(runner.directory, path), "utf8")).toBe("existing fixture")
  expect(await readdir(runner.directory)).toEqual([path])
  const shared = join(runner.directory, "shared")
  await mkdir(shared)
  await chmod(shared, 0o770)
  expect(await create("shared/new.ipynb")).toMatchObject({ error: "EDIT_UNAVAILABLE" })
  expect(await readdir(shared)).toEqual([])
})

it("installs restricted edit defaults even without a base rule and retains explicit overrides", () => {
  for (const [access, effect] of [["ask-changes", "ask"], ["read-only", "deny"]] as const) {
    const defaults = surfaceRules(access)
    const scopedWildcard = { action: "*", resource: "default:*", effect: "allow" } as const
    const inserted = editingDefaults([scopedWildcard], defaults, access)
    expect(editEffect(inserted)).toBe(effect)
    expect(editingDefaults(inserted, defaults, access)).toEqual(inserted)
    expect(editEffect(editingDefaults([{ action: "colab.edit", resource: "*", effect: "allow" }, scopedWildcard], defaults, access))).toBe("allow")
  }
  const blanketAsk = { action: "*", resource: "*", effect: "ask" } as const
  expect(hasBroaderEditEffect([...surfaceRules("read-only"), blanketAsk])).toBe(true)
  expect(editEffect(editingDefaults([blanketAsk], surfaceRules("read-only"), "read-only"))).toBe("deny")
})

it("find stays within the project even when an external local root is explicitly allowed", async () => {
  const runner = await setup()
  const external = (await setup()).directory
  const target = join(external, "Quarter 1 - résumé.ipynb")
  const tool = { ...runner, options: loadEditingOptions({ allowedRoots: [external] }) }
  const source = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] })
  await writeFile(target, source)
  expect(await runEditingTool("notebook", { notebook: { path: target } }, call, runner)).toMatchObject({ error: "PATH_REFUSED" })
  runner.assert.mockClear()
  expect(await runEditingTool("find", {}, call, tool)).toMatchObject({ notebooks: [] })
  expect(await runEditingTool("notebook", { notebook: { path: target } }, call, tool)).toMatchObject({ state: "ok", cells: [] })
  expect(runner.assert.mock.calls.map(([request]) => request.action)).toEqual(["colab.find", "colab.notebook", "external_directory", "read"])
  for (const [request] of runner.assert.mock.calls.slice(2)) {
    expect(request.resources).toEqual([target])
    expect(request.save).toEqual([target])
  }
  const editRequests = localFileRequests({ absolute: target, relative: target, insideProject: false }, "edit")
  expect(editRequests.map(({ action, resources, save }) => [action, resources, save])).toEqual([
    ["edit", [target], [target]], ["external_directory", [target], [target]],
  ])
  await writeFile(join(runner.directory, "one.ipynb"), source)
  await writeFile(join(runner.directory, "two.ipynb"), source)
  expect(await runEditingTool("find", { limit: 1 }, call, tool)).toMatchObject({ notebooks: [{ path: "one.ipynb" }], truncated: true })
})

it("refuses ambiguous literal notebook names and roots before requesting any permission", async () => {
  const runner = await setup()
  const path = "Notes [draft].ipynb"
  const workspace = join(runner.directory, "Workspace [draft]")
  const external = join((await setup()).directory, "Review (archive)")
  await mkdir(workspace)
  await mkdir(external)
  const fixtures = [
    { runner, path },
    { runner: { ...runner, directory: await realpath(workspace) }, path: "Notes.ipynb" },
    { runner: { ...runner, options: loadEditingOptions({ allowedRoots: [external] }) }, path: join(external, "Notes.ipynb") },
  ]
  for (const fixture of fixtures) {
    const filename = resolve(fixture.runner.directory, fixture.path)
    await writeFile(filename, "untouched local fixture")
    expect(await runEditingTool("notebook", { notebook: { path: fixture.path } }, call, fixture.runner)).toMatchObject({ error: "PATH_REFUSED" })
    expect(await runEditingTool("edit", { path: fixture.path, ops: [{ op: "create" }] }, call, fixture.runner)).toMatchObject({ error: "PATH_REFUSED" })
    expect(await readFile(filename, "utf8")).toBe("untouched local fixture")
  }
  expect(runner.assert).not.toHaveBeenCalled()
})
