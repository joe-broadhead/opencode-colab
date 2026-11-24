// Shipped declaration checks plus the latent full registry’s asserted-action invariant.
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it } from "vitest"
import { DECLARED_ACTIONS, READ_ACTION, TOOLS, actionOf } from "../../src/domain/actions.js"
import type { ToolName } from "../../src/domain/contract.js"
import { loadEditingOptions } from "../../src/editing/options.js"
import { surfaceRules, SURFACE_DECLARED_ACTIONS, SURFACE_TOOLS } from "../../src/editing/tools.js"
import { effectOf } from "../../src/permissions.js"
import { SKILL_IDS } from "../../src/skills.js"
import { sourceMethods } from "../../src/sources/index.js"
import { toolHandlers } from "../../src/tools/registry.js"
import { HOST_ACTIONS, runTool, type Runner } from "../../src/tools/spec.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingsProblems } from "../support/jelly-settings.js"

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
const jelly = manifest.jelly as Declaration & { tools: DeclaredTool[]; contributes: { settings: PluginSetting[] } }

it("carries the pinned Jelly family block exactly once", () => {
  const block = /<!-- family-block:start -->[\s\S]*?<!-- family-block:end -->/g
  const vendored = readFileSync(new URL("scripts/jelly-family-block.md", ROOT), "utf8").match(block)
  const documented = readFileSync(new URL("docs/jelly.md", ROOT), "utf8").match(block)
  expect(vendored).toHaveLength(1)
  expect(documented).toEqual(vendored)
})

const call = (id: string) => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id, signal: new AbortController().signal })

/** Every tool run once against the fakes, recording what it asserts. */
async function assertedActions(): Promise<Map<ToolName, string[]>> {
  const { deps } = fakeDeps()
  const permission = new RecordingPermission()
  let runner: Runner
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
  const inputs: Record<ToolName, unknown> = {
    status: {},
    specs: {},
    runtimes: {},
    find: { where: "workspace" },
    notebook: { notebook: { path: "a.ipynb" } },
    files: { runtime: "oc-01" },
    execution: { runId: "run-1" },
    jobs: {},
    schedules: {},
    plan: { action: "runtime.create", params: { spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } } },
    events_list: { source: "colab.runs" },
    runtimes_read: {},
    // A failing second op, so an all-or-nothing edit that creates writes no file.
    edit: { path: "a.ipynb", ops: [{ op: "create" }, { op: "delete", cell: 99 }] },
    run: { runtime: "oc-01", code: "print(1)" },
    cancel: { runId: "run-1" },
    upload: { runtime: "oc-01", path: "data.csv" },
    download: { runtime: "oc-01", path: "/content/outputs/x.csv" },
    pause: { schedule: "schedules/1" },
    write: { planId: "" },
    delete: { planId: "" },
  }
  const out = new Map<ToolName, string[]>()
  for (const tool of TOOLS) {
    const name = tool.name as ToolName
    let input = inputs[name]
    if (name === "write" || name === "delete") {
      // A stored plan, so the commit reaches its assert.
      const plan = deps.plans.create({
        action: name === "write" ? "runtime.create" : "runtime.delete",
        category: name,
        account: "default",
        backend: "colab",
        operation: name === "write" ? "colaboratory.runtimes.create" : "colaboratory.runtimes.delete",
        sessionId: "ses_test",
        agentId: "build",
        preview: {},
        payload: {},
        fingerprint: {},
      })
      input = { planId: plan.id }
    }
    const before = permission.requests.length
    // A source read throws its refusals as the contract's SourceError (colab-15 request 4); either answer is fine here.
    await runTool(name, input, call(`call_${name}`), runner).catch((error: unknown) => {
      if (!(error instanceof SourceError)) throw error
    })
    out.set(name, permission.requests.slice(before).map((request) => request.action))
  }
  return out
}

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const problems = declarationProblems(ROOT, { effectOf: effectFromRules(surfaceRules()), registered: SURFACE_DECLARED_ACTIONS, actionPermissions: true })
    expect(problems).toEqual([])
  })

  it("declares exactly three local tools and no sign-in or sources", () => {
    expect(jelly.tools).toEqual(SURFACE_TOOLS.map(({ action, codemode }) => ({ name: action, permission: action, effect: "allow", readOnly: codemode })))
    expect(jelly.tools).toHaveLength(3)
    expect(jelly.tools.filter((tool) => tool.readOnly)).toHaveLength(2)
    expect(jelly).not.toHaveProperty("signIns")
    expect(manifest).not.toHaveProperty("sources")
  })

  it("latent registry: each tool asserts exactly its own action, once, before anything runs", async () => {
    const asserted = await assertedActions()
    // Package-neutral: a built tool also asserts colab.read for its provider reads, and OpenCode's own host actions
    // (edit, external_directory, read) through hostAssert; its own action comes first, once.
    for (const tool of TOOLS) {
      const actions = (asserted.get(tool.name as ToolName) ?? []).filter((action) => !HOST_ACTIONS.has(action))
      expect(actions[0], tool.name).toBe(actionOf(tool.name))
      expect(actions.filter((action) => action !== READ_ACTION), tool.name).toEqual([actionOf(tool.name)])
    }
    const all = new Set([...[...asserted.values()].flat().filter((action) => !HOST_ACTIONS.has(action)), READ_ACTION, ...sourceMethods().map((method) => method.action)])
    expect([...all].sort()).toEqual([...DECLARED_ACTIONS].sort())
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("states the cost and the admin step within Jelly's limits", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
    expect(jelly.cost).toMatch(/no Google requests/)
    expect(jelly.admin).toMatch(/No sign-in/)
  })

  it("declares access with Jelly's own words and the parser's default", () => {
    const settings = jelly.contributes.settings
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settings[0]!.choices).toEqual(ACCESS_CHOICES)
    expect(settings[0]!.default).toBe(loadEditingOptions({}).access)
  })
})

/**
 * Jelly's `accessRules` (backend/host/src/connections/plugin-access.ts), ported: the namespace patterns `colab.*` and
 * `colab_*` get the namespace effect, then one rule per declared permission through `effectOfAccess`; the last match
 * wins. `effectOfAccess` is protocol/contracts/src/plugin-access.light.ts, word for word in logic.
 */
function effectOfAccess(access: string, readOnly: boolean, declared: string): string {
  if (access === "all") return "allow"
  if (declared === "deny") return "deny"
  if (access === "ask-changes" && declared === "ask") return "ask"
  if (readOnly) return "allow"
  return access === "read-only" ? "deny" : "ask"
}

function jellyEffect(access: string, action: string): string {
  const namespace = access === "all" ? "allow" : access === "read-only" ? "deny" : "ask"
  const rules = [
    { action: "colab.*", effect: namespace },
    { action: "colab_*", effect: namespace },
    ...jelly.tools.map((tool) => ({ action: tool.permission, effect: effectOfAccess(access, tool.readOnly === true, tool.effect) })),
  ]
  const wild = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)
  return rules.findLast((rule) => wild(rule.action).test(action))?.effect ?? "unmatched"
}

describe("Jelly's access rules, simulated over every action the plugin can assert", () => {
  const reads = new Set<string>(SURFACE_TOOLS.filter((tool) => tool.codemode).map((tool) => tool.action))
  const expected: Record<string, { read: string; change: string }> = {
    all: { read: "allow", change: "allow" },
    "ask-changes": { read: "allow", change: "ask" },
    "read-only": { read: "allow", change: "deny" },
  }
  for (const access of ["all", "ask-changes", "read-only"] as const) {
    it(`at ${access}: local reads allow and editing follows the choice`, () => {
      for (const action of SURFACE_DECLARED_ACTIONS) {
        const want = reads.has(action) ? expected[access]!.read : expected[access]!.change
        expect(jellyEffect(access, action), `${action} at ${access}`).toBe(want)
      }
    })

    it(`at ${access}: the plugin's own default rules agree with Jelly for every tool action`, () => {
      const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...surfaceRules(access)]
      for (const action of SURFACE_DECLARED_ACTIONS) expect(effectOf(rules, action), `${action} at ${access}`).toBe(jellyEffect(access, action))
    })
  }
})

const contracts = process.env.JELLY_CONTRACTS

describe("Jelly's own PluginDeclarationSchema", () => {
  it.skipIf(!contracts)("accepts the declaration, with no unknown field", async () => {
    const module = (await import(pathToFileURL(`${contracts}/plugin-contract.ts`).href)) as {
      PluginDeclarationSchema: { safeParse(value: unknown): { success: boolean; error?: { issues: { path: unknown[]; message: string }[] } } }
      unknownDeclarationFields(value: unknown): string[]
    }
    const issues = (value: unknown) => {
      const result = module.PluginDeclarationSchema.safeParse(value)
      return result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    }
    expect(issues(jelly)).toEqual([])
    expect(module.unknownDeclarationFields(jelly)).toEqual([])
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
