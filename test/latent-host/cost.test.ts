// The built plugin in an embedded OpenCode host, on each of the six tested releases: H2's default rules at every access
// level over `colab.*`, `colab.read`, `colab.probe` and the command action `colab.cleanup`; and H9's automation consent
// plus `/colab-cleanup`'s person-only prompt — a report at read-only that takes nothing, and one prompt per runtime at
// `all`, with no tool `source`, whose refusal changes nothing. Nothing leaves the machine: the harness fails the host's
// close on any request off loopback.
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test"
import { rmSync } from "node:fs"
import { join } from "node:path"
import { FileLedger, ledgerDir } from "../../src/ledger/store.js"
import { effectOf, type Rule } from "../../src/permissions.js"
import { isStatus, type Status } from "../../src/rpc.js"
import { agentRules, cleanup, pluginState, startHost, status, until, type Host } from "./harness.js"

setDefaultTimeout(180_000)
afterAll(cleanup)

const CALIBRATION = { hiddenPathsVisible: false, baselineConnections: {}, probeKernel: { id: "kernel-probe", executionCount: 1, startMs: 10, rttMs: 5 }, snippetVersion: "host", at: "2026-11-17T09:00:00.000Z" }
const SPEC = { variant: "VARIANT_GPU" as const, shape: "SHAPE_STANDARD" as const, accelerator: "T4" }

const session = async (host: Host, agent = "build") => (await host.client.sessions.create({ agent, location: host.location })).id

const effect = async (host: Host, agent: string, action: string) => {
  const sessionID = await session(host, agent)
  return (await host.client.permission.create({ sessionID, agent, action, resources: ["*"] })).effect
}

/** The synthetic texts a session's inbox holds, oldest first. */
const posted = async (host: Host, sessionID: string) => {
  const inbox = await host.client.session.inbox.list({ sessionID })
  return inbox.filter((item) => item.type === "synthetic").map((item) => (item.type === "synthetic" ? item.payload.text : ""))
}

const store = () => new FileLedger(ledgerDir(process.env), { ledgerDays: 90 })

describe("H2: the default rules at each access level", () => {
  const cases = [
    { access: "all", change: "allow", cleanup: "ask" },
    { access: "ask-changes", change: "ask", cleanup: "ask" },
    { access: "read-only", change: "deny", cleanup: "deny" },
  ] as const

  for (const entry of cases) {
    test(`at ${entry.access}: reads and the permission-only reads allow, changes ${entry.change}, colab.cleanup ${entry.cleanup}`, async () => {
      const host = await startHost({ options: { access: entry.access } })
      try {
        const rules = (await agentRules(host)).get("build") as Rule[]
        expect(rules).toContainEqual({ action: "colab.cleanup", resource: "*", effect: entry.cleanup })
        expect(rules).toContainEqual({ action: "colab.read", resource: "*", effect: "allow" })
        expect(rules).toContainEqual({ action: "colab.probe", resource: "*", effect: "allow" })
        // The host's own evaluation, for the agent the plugin guarded.
        expect(await effect(host, "build", "colab.status")).toBe("allow")
        expect(await effect(host, "build", "colab.read")).toBe("allow")
        expect(await effect(host, "build", "colab.run")).toBe(entry.change)
        expect(await effect(host, "build", "colab.cleanup")).toBe(entry.cleanup)
        // The plugin's own block agrees with the host's evaluation for every action it can assert.
        const block = [{ action: "*", resource: "*", effect: "allow" as const }, ...rules.filter((rule) => rule.action !== "*")]
        for (const action of ["colab.status", "colab.run", "colab.delete", "colab.read", "colab.probe", "colab.cleanup"]) {
          expect(effectOf(block, action), action).toBe(await effect(host, "build", action))
        }
      } finally {
        await host.close()
      }
    }, 180_000)
  }
})

describe("H9: automation consent", () => {
  test("status reports on at all, off (access) at ask-changes and read-only, off at the option, and on (consent) where the person allowed it", async () => {
    const cases: { options: Record<string, unknown>; automation: Status["automation"] }[] = [
      { options: {}, automation: "on" },
      { options: { access: "ask-changes" }, automation: "off (access)" },
      { options: { access: "read-only" }, automation: "off (access)" },
      { options: { access: "read-only", automation: "on" }, automation: "on (consent)" },
      { options: { access: "all", automation: "off" }, automation: "off" },
    ]
    for (const entry of cases) {
      const host = await startHost({ options: entry.options })
      try {
        const answer = await status(host)
        expect(isStatus(answer)).toBe(true)
        expect(answer.automation, JSON.stringify(entry.options)).toBe(entry.automation)
        expect(answer.cost).toEqual(expect.objectContaining({ runtimesRunning: expect.any(Number) }))
      } finally {
        await host.close()
      }
    }
  })

  test("lists /colab-cleanup beside /colab-status", async () => {
    const host = await startHost()
    try {
      const commands = (await host.client.command.list({ location: host.location })).data.map((command) => command.name)
      expect(commands).toEqual(expect.arrayContaining(["colab-status", "colab-cleanup"]))
      expect(await pluginState(host)).toEqual({ status: "active" })
    } finally {
      await host.close()
    }
  })

  test("at read-only, /colab-cleanup lists what costs money and asks nothing: the report is posted, no permission request appears", async () => {
    const host = await startHost({ options: { access: "read-only" } })
    try {
      const sessionID = await session(host)
      await host.client.sessions.command({ sessionID, name: "colab-cleanup", text: "" })
      const texts = await until("/colab-cleanup posts its report", async () => {
        const all = await posted(host, sessionID)
        return all.length > 0 ? all : undefined
      })
      expect(texts[0]).toContain("Read only: a report")
      expect(await host.client.permission.list({ sessionID })).toEqual([])
    } finally {
      await host.close()
    }
  })
})

describe("H9: /colab-cleanup's person-only prompt", () => {
  const id = "oc-01jhostcleanup000000000"

  const seed = async () => {
    await store().putRuntime({
      id,
      account: "default",
      backend: "colab",
      spec: SPEC,
      createdAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      nonce: "n1",
      keep: ["/content/outputs/**"],
      lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
      state: "ready",
      calibration: CALIBRATION,
    })
  }

  test("asks once per runtime with colab.cleanup and no source, and a refusal changes nothing", async () => {
    await seed()
    try {
      const host = await startHost({ options: { access: "all" } })
      try {
        const sessionID = await session(host)
        // The command waits for the person's answer, so it is started without awaiting it.
        const running = host.client.sessions.command({ sessionID, name: "colab-cleanup", text: "" })
        const request = await until("the cleanup prompt appears", async () => {
          const pending = await host.client.permission.list({ sessionID })
          return pending.find((item) => item.action === "colab.cleanup")
        })
        // A person-only prompt: no tool `source`, the runtime as the resource, what is lost in the metadata.
        expect(request.source).toBeUndefined()
        expect(request.resources).toEqual([`default:runtime:${id}`])
        expect(request.metadata).toMatchObject({ runtime: id, lost: expect.stringContaining("Files outside keep") })
        await host.client.permission.reply({ sessionID, requestID: request.id, decision: "reject" })
        await running.catch(() => undefined)
        const texts = await until("the cleanup outcome is posted", async () => {
          const all = await posted(host, sessionID)
          return all.some((text) => text.includes("declined")) ? all : undefined
        })
        expect(texts.join("\n")).toContain("declined")
      } finally {
        await host.close()
      }
      // Nothing was released: the ledger record is still ready.
      expect(await store().getRuntime(id)).toMatchObject({ state: "ready" })
    } finally {
      rmSync(join(ledgerDir(process.env), "runtimes", `${id}.json`), { force: true })
    }
  })
})
