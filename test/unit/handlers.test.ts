import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, test } from "vitest"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { accountsFor } from "../../src/accounts.js"
import { PLAN_ACTION_NAMES } from "../../src/domain/actions.js"
import { changedCapability } from "../../src/handlers/changed.js"
import { createHandlers } from "../../src/handlers/index.js"
import { manifest, version } from "../../src/manifest.js"
import { fakeDeps } from "../fakes/index.js"

const directory = mkdtempSync(join(tmpdir(), "colab-handlers-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

const call = (account: string, events: { name: string; data: unknown }[] = []): MethodCall =>
  ({
    sessionID: "ses_handlers",
    agent: "build",
    messageID: "msg_handlers",
    id: "call_handlers",
    signal: new AbortController().signal,
    progress: async () => undefined,
    account,
    bus: {
      emit: async (name: string, data: unknown) => {
        events.push({ name, data })
        return { ok: true }
      },
    },
    access: { rules: [] },
    unguardedAgents: async () => ({ ok: true, agents: [] }),
    door: "rpc",
  }) as unknown as MethodCall

const table = () => {
  const raw = { access: "all", accounts: { work: { access: "write" } } }
  const { deps, fakes } = fakeDeps({ options: raw, directory })
  fakes.auth.grants.set("work", ["https://www.googleapis.com/auth/colaboratory"])
  const handlers = createHandlers({ deps, manifest, version, hostVersion: "2.4.1", profiles: accountsFor(manifest, raw), problems: [] })
  return { handlers, fakes, deps }
}

describe("local notebook handlers", () => {
  test("edit creates a notebook, notebook reads it and find lists it", async () => {
    const { handlers } = table()
    const edited = (await handlers.edit!.run({ path: "note.ipynb", ops: [{ op: "create", cells: [] }] }, call("work"))) as Record<string, unknown>
    expect(edited).toMatchObject({ state: "ok", path: expect.stringContaining("note.ipynb"), cells: 0 })
    const read = (await handlers.notebook!.run({ notebook: { path: "note.ipynb" } }, call("work"))) as Record<string, unknown>
    expect(read).toMatchObject({ state: "ok", nbformat: "4.5", cells: [] })
    const found = (await handlers.find!.run({ where: "workspace", pattern: "*.ipynb" }, call("work"))) as Record<string, unknown>
    expect((found.notebooks as { path?: string }[]).some((item) => item.path?.endsWith("note.ipynb"))).toBe(true)
  })

  test("a write on a read account is refused before the file is touched", async () => {
    const raw = { access: "all", accounts: { work: { access: "read" } } }
    const { deps } = fakeDeps({ options: raw, directory })
    const handlers = createHandlers({ deps, manifest, version, hostVersion: "2.4.1", profiles: accountsFor(manifest, raw), problems: [] })
    await expect(handlers.edit!.run({ path: "blocked.ipynb", ops: [{ op: "create", cells: [] }] }, call("work"))).rejects.toMatchObject({ refusal: { code: "PERMISSION_DENIED" } })
  })
})

describe("status, probe and usage", () => {
  test("status is the contract's exact answer", async () => {
    const { handlers } = table()
    const answer = (await handlers.status!.run({}, call("default"))) as Record<string, unknown>
    expect(Object.keys(answer).sort()).toEqual(["accounts", "host", "name", "nextStep", "state", "unguardedAgents", "version"])
    expect(answer).toMatchObject({ name: "colab", version: "0.0.0", state: "ready", unguardedAgents: [], nextStep: null })
    expect(answer.accounts).toEqual([expect.objectContaining({ alias: "work", state: "ready" })])
  })

  test("probe names the local owner for runs and the account owner for runtimes", async () => {
    const { handlers } = table()
    const runs = (await handlers.probe!.run({ source: "runs" }, call("work"))) as Record<string, unknown>
    expect(runs).toMatchObject({ source: "runs", account: "work", trust: "untrusted" })
    expect((runs.owner as { id: string }).id).toMatch(/^os-user:/)
    const runtimes = (await handlers.probe!.run({ source: "runtimes" }, call("work"))) as Record<string, unknown>
    expect(runtimes).toMatchObject({ source: "runtimes", account: "work", trust: "untrusted" })
    expect((runtimes.owner as { id: string }).id).toMatch(/^(mailto:|colab:account:)/)
  })

  test("usage is the rich product status", async () => {
    const { handlers } = table()
    const answer = (await handlers.usage!.run({}, call("work"))) as Record<string, unknown>
    expect(answer).toMatchObject({ state: "ok", automation: expect.any(String) })
    expect(Array.isArray(answer.accounts)).toBe(true)
    expect(Array.isArray(answer.runtimes)).toBe(true)
    expect(Array.isArray(answer.cleanup)).toBe(true)
  })
})

describe("changed after every change (contract §4.7)", () => {
  test("edit nudges the notebook area with the account and the action", async () => {
    const { handlers } = table()
    const events: { name: string; data: unknown }[] = []
    const edited = (await handlers.edit!.run({ path: "bus.ipynb", ops: [{ op: "create", cells: [] }] }, call("work", events))) as Record<string, unknown>
    expect(edited).toMatchObject({ state: "ok" })
    expect(events).toEqual([{ name: "changed", data: { capability: "colab.notebooks", account: "work", reason: "edit" } }])
  })

  test("cleanup nudges the runtime area even when it releases nothing", async () => {
    const { handlers } = table()
    const events: { name: string; data: unknown }[] = []
    await handlers.cleanup!.run({}, call("work", events))
    expect(events).toEqual([{ name: "changed", data: { capability: "colab.runtimes", account: "work", reason: "cleanup" } }])
  })

  test("every non-read method and every plan action has one of the five areas", () => {
    const methods = {
      edit: "colab.notebooks",
      run: "colab.runs",
      cancel: "colab.runs",
      upload: "colab.runtimes",
      download: "colab.files",
      pause: "colab.schedules",
      cleanup: "colab.runtimes",
    } as const
    for (const [method, capability] of Object.entries(methods)) expect(changedCapability(method), method).toBe(capability)
    for (const action of PLAN_ACTION_NAMES) {
      const capability = changedCapability(action)
      expect(capability, action).toMatch(/^colab\.[a-z][a-z0-9-]*$/)
      if (action.startsWith("runtime.")) expect(capability, action).toBe("colab.runtimes")
      if (action.startsWith("job.")) expect(capability, action).toBe("colab.runs")
      if (action.startsWith("schedule.")) expect(capability, action).toBe("colab.schedules")
      if (action.startsWith("drive.")) expect(capability, action).toBe("colab.notebooks")
    }
    // The manifest's non-read methods are the mapped ones plus the two plan commits, whose areas come from the action.
    const changing = Object.entries(manifest.methods).filter(([, item]) => item.class !== "read").map(([name]) => name)
    expect(changing.sort()).toEqual([...Object.keys(methods), "delete", "write"].sort())
    expect(() => changedCapability("status")).toThrow("no capability")
  })
})
