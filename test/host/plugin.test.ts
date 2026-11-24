// Embedded and offline on every pinned SDK. The released surface is tested, not the latent provider registry.
import { afterAll, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES } from "../../src/constants.js"
import { surfaceRules } from "../../src/editing/tools.js"
import { notebookHash } from "../../src/notebooks/model.js"
import { isStatus } from "../../src/rpc.js"
import { agentRules, cleanup, pluginState, startHost, status, until, type Host } from "./harness.js"
import { ROOT } from "./isolate.js"

afterAll(cleanup)

const object = { type: "object" } as const
const method = { input: object, output: object }
const rpc = Rpc.define({
  id: "google-colab.tools",
  // Also describe deliberately absent methods on the client so the host must reject their routes.
  methods: { describe: method, find: method, notebook: method, edit: method, run: method, probe: method, events_list: method, runtimes_read: method },
  events: {},
})
const session = async (host: Host) => (await host.client.session.create({ agent: "build", location: host.location })).id

test("loads the exact native, Code Mode, command, skill and read RPC surfaces; local edits round-trip", async () => {
  const host = await startHost()
  try {
    expect(await pluginState(host)).toEqual({ status: "active" })
    const tools = new Map((await host.probe().tool.list()).filter(({ id }) => id.startsWith("colab_")).map((tool) => [tool.id, tool]))
    expect([...tools.keys()].sort()).toEqual(["colab_edit", "colab_find", "colab_notebook"])
    expect([...tools.values()].filter((tool) => tool.options?.codemode).map((tool) => tool.id).sort()).toEqual(["colab_find", "colab_notebook"])
    expect((await host.client.integration.list({ location: host.location })).data.filter(({ id }) => id.startsWith("colab-"))).toEqual([])
    expect((await host.client.command.list({ location: host.location })).data.map(({ name }) => name).filter((name) => name.startsWith("colab-"))).toEqual(["colab-status"])
    expect((await host.probe().skill.list()).data.map(({ id }) => id).filter((id) => id === "colab" || id === "colab-notebooks").sort()).toEqual(["colab", "colab-notebooks"])
    const answer = await status(host)
    expect(isStatus(answer)).toBe(true)
    expect(answer).toMatchObject({ surface: "editing", access: "all", accounts: [], tools: { registered: 3 }, unguardedAgents: [],
      nextStep: expect.stringContaining("local notebooks"), cost: { runtimeHoursToday: 0, runtimesRunning: 0 }, automation: "off" })

    const sessionID = await session(host)
    let seq = 0
    const call = async (name: string, input: unknown) => (await tools.get(`colab_${name}`)!.execute(input as never, {
      sessionID, agent: "build", messageID: `msg_colab_${++seq}`, id: `call_colab_${seq}`,
      progress: async () => undefined, signal: new AbortController().signal,
    } as never)).output as Record<string, unknown>
    const path = "example.ipynb"
    const created = await call("edit", { path, ops: [{ op: "create", cells: [{ type: "markdown", source: "before" }] }] })
    if (process.platform !== "linux") {
      expect(created).toMatchObject({ error: "EDIT_UNAVAILABLE" })
      expect(await readdir(host.location.directory)).not.toContain(path)
      await writeFile(join(host.location.directory, path), fixture)
    } else {
      expect(created).toMatchObject({ state: "ok", path, cells: 1 })
    }
    const hash = notebookHash(await readFile(join(host.location.directory, path)))
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(await call("find", {})).toMatchObject({ state: "ok", notebooks: [{ path, where: "workspace" }] })
    expect(await call("find", { where: "drive" })).toMatchObject({ state: "refused", error: "EXECUTION_UNAVAILABLE" })
    expect(await call("notebook", { notebook: { path } })).toMatchObject({ state: "ok", hash, trust: "untrusted" })
    const changed = await call("edit", { path, ifHash: hash, ops: [{ op: "replace", cell: 0, source: "after" }] })
    if (process.platform === "linux") {
      expect(changed).toMatchObject({ state: "ok", path })
      expect(changed.hash as string).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(changed.hash).not.toBe(hash)
      expect(await readFile(join(host.location.directory, path), "utf8")).toContain('"after"')
      expect(await call("edit", { path, ifHash: hash, ops: [{ op: "replace", cell: 0, source: "unchanged" }] })).toMatchObject({ error: "NOTEBOOK_CHANGED" })
    } else {
      expect(changed).toMatchObject({ error: "EDIT_UNAVAILABLE" })
      expect(await readFile(join(host.location.directory, path), "utf8")).toBe(fixture)
    }

    const transport = host.client.rpc(rpc)
    const opts = { location: host.location }
    const described = await transport.describe({}, opts) as { methods: { name: string; class: string }[] }
    expect(described.methods.map(({ name, class: cls }) => [name, cls])).toEqual([["find", "read"], ["notebook", "read"]])
    expect(await transport.find({ sessionID, input: {} }, opts)).toMatchObject({ state: "ok", notebooks: [{ path }] })
    expect(await transport.notebook({ sessionID, input: { notebook: { path } } }, opts)).toMatchObject({ state: "ok", hash: changed.hash ?? hash })
    for (const name of ["edit", "run", "probe", "events_list", "runtimes_read"] as const) {
      await expect(transport[name]({ sessionID, input: {} }, opts)).rejects.toThrow()
    }
    const unattended = await host.client.session.create({
      agent: "build", location: host.location, permissions: [{ action: "read", resource: "*", effect: "ask" }],
    })
    await expect(transport.notebook({ sessionID: unattended.id, input: { notebook: { path } } }, {
      ...opts, signal: AbortSignal.timeout(10_000),
    })).rejects.toMatchObject({ data: { code: "PERMISSION_DENIED" } })
    expect(await host.client.permission.list({ sessionID: unattended.id })).toEqual([])
    await host.client.session.command({ sessionID, name: "colab-status", text: "" })
    const text = await until("status posts its report", async () => (await host.client.session.inbox.list({ sessionID }))
      .find((item) => item.type === "synthetic" && item.payload.text.includes("Editing only")))
    expect(text.type).toBe("synthetic")
  } finally {
    await host.close()
  }
}, 120_000)

const fixture = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ id: "example", cell_type: "markdown", metadata: {}, source: ["before"] }] })

test("an approved external read asks with the exact file as both resource and saved scope", async () => {
  const outside = await mkdtemp(join(ROOT, "external-"))
  const absolute = join(outside, "Quarter 1 - notes.ipynb")
  await writeFile(absolute, fixture)
  const host = await startHost({ options: { allowedRoots: [outside] } })
  try {
    const { id: sessionID } = await host.client.session.create({
      agent: "build", location: host.location, permissions: [{ action: "external_directory", resource: "*", effect: "ask" }],
    })
    const tool = (await host.probe().tool.list()).find(({ id }) => id === "colab_notebook")!
    const call = tool.execute({ notebook: { path: absolute } } as never, {
      sessionID, agent: "build", messageID: "msg_external", id: "call_external", progress: async () => undefined, signal: AbortSignal.timeout(15_000),
    } as never)
    const pending = await until("the external file check prompts", async () => (await host.client.permission.list({ sessionID }))[0], 10_000)
    expect(pending).toMatchObject({ action: "external_directory", resources: [absolute], save: [absolute] })
    await host.client.permission.reply({ sessionID, requestID: pending.id, decision: "once" })
    expect((await call).output).toMatchObject({ state: "ok", hash: notebookHash(Buffer.from(fixture)) })
  } finally {
    await host.close()
  }
}, 120_000)

for (const access of ["ask-changes", "read-only"] as const) {
  test(`${access}: direct edits obey the default for built-in and custom agents`, async () => {
    const host = await startHost({ options: { access }, config: () => ({ agents: { reviewer: { description: "Reviews local notes", mode: "primary" } } }) })
    try {
      const listed = await agentRules(host)
      const path = "example.ipynb"
      const absolute = join(host.location.directory, path)
      await writeFile(absolute, fixture)
      const tool = (await host.probe().tool.list()).find(({ id }) => id === "colab_edit")!
      for (const [agent, explicit] of [["build", false], ["reviewer", false], ["reviewer", true]] as const) {
        const selected = await host.client.session.create({
          agent, location: host.location,
          ...(explicit ? { permissions: [{ action: "colab.edit", resource: "*", effect: access === "ask-changes" ? "ask" : "deny" }] } : {}),
        })
        expect(selected.agent).toBe(agent)
        const sessionID = selected.id
        let outcome: { status: string; output?: unknown } | undefined
        const completed = tool.execute({ path, ifHash: notebookHash(Buffer.from(fixture)), ops: [{ op: "replace", cell: 0, source: "after" }] } as never, {
          sessionID, agent, messageID: `msg_guard_${agent}_${explicit}`, id: `call_guard_${agent}_${explicit}`, progress: async () => undefined, signal: AbortSignal.timeout(15_000),
        } as never).then(({ output }) => (outcome = { status: "fulfilled", output }), () => (outcome = { status: "rejected" }))
        const unguarded = !explicit && !listed.get(agent)?.some(({ action }) => action === "colab.edit")
        if (!unguarded && access === "ask-changes") {
          const pending = await until(`a direct ${agent} edit prompts`, async () => {
            if (outcome) throw new Error(`The direct ${agent} edit completed before showing a prompt: ${JSON.stringify(outcome)}`)
            return (await host.client.permission.list({ sessionID }))[0]
          }, 10_000)
          expect(pending.action).toBe("colab.edit")
          expect(await readFile(absolute, "utf8")).toBe(fixture)
          await host.client.permission.reply({ sessionID, requestID: pending.id, decision: "reject" })
        }
        if (unguarded) expect(await completed).toMatchObject({ status: "fulfilled", output: { state: "refused", error: "PERMISSION_DENIED" } })
        else expect(await completed).toEqual({ status: "rejected" })
        expect(await host.client.permission.list({ sessionID })).toEqual([])
        expect(await readFile(absolute, "utf8")).toBe(fixture)
        expect((await readdir(host.location.directory)).filter((name) => name.startsWith(".colab-edit-"))).toEqual([])
      }

      if (access === "read-only") {
        const agent = "reviewer"
        const sessionID = (await host.client.session.create({
          agent, location: host.location, permissions: [{ action: "colab.edit", resource: "*", effect: "allow" }, { action: "edit", resource: "*", effect: "allow" }],
        })).id
        const override = await tool.execute({ path, ifHash: notebookHash(Buffer.from(fixture)), ops: [{ op: "replace", cell: 0, source: "override" }] } as never, {
          sessionID, agent, messageID: "msg_guard_override", id: "call_guard_override", progress: async () => undefined, signal: AbortSignal.timeout(10_000),
        } as never)
        if (process.platform === "linux") {
          expect(override.output).toMatchObject({ state: "ok" })
          expect(await readFile(absolute, "utf8")).toContain('"override"')
        } else {
          expect(override.output).toMatchObject({ error: "EDIT_UNAVAILABLE" })
          expect(await readFile(absolute, "utf8")).toBe(fixture)
        }
      }
    } finally {
      await host.close()
    }
  }, 120_000)
}

for (const access of ACCESS_VALUES) {
  test(`${access}: inserts only the local rules and the host evaluates each action`, async () => {
    const host = await startHost({ options: { access } })
    try {
      const rules = (await agentRules(host)).get("build") ?? []
      const defaults = surfaceRules(access)
      expect(rules.filter(({ action }) => action.startsWith("colab."))).toEqual(defaults)
      const base = rules.findIndex((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
      expect(base).toBeGreaterThanOrEqual(0)
      expect(rules.slice(base + 1, base + 1 + defaults.length)).toEqual(defaults)
      const sessionID = await session(host)
      for (const { action, effect } of defaults.slice(1)) {
        expect((await host.client.permission.create({ sessionID, agent: "build", action, resources: ["*"] })).effect).toBe(effect)
      }
      expect((await status(host)).automation).toBe("off")
    } finally {
      await host.close()
    }
  }, 120_000)
}

test("refuses unknown and provider options, and a host outside the range", async () => {
  for (const [input, code] of [[{ options: { acess: "all" } }, "OPTIONS_INVALID"], [{ options: { accounts: {} } }, "OPTIONS_INVALID"], [{ version: "2.1.0" }, "HOST_UNTESTED"]] as const) {
    const host = await startHost(input)
    try {
      expect(await pluginState(host)).toMatchObject({ status: "failed", error: expect.stringContaining(code) })
    } finally {
      await host.close()
    }
  }
}, 240_000)
