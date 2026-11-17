/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard; the tests below add what only Colab declares:
 *
 * - asserted equals declared: every action a tool asserts is declared, and every declared action is asserted;
 * - `colab.read` and `colab.probe` are permission-only, read-only entries;
 * - a port of Jelly's `accessRules` gives every action the plugin can assert a rule at each access level, and reads
 *   never ask or deny;
 * - with an export of Jelly's contracts at hand (`JELLY_CONTRACTS`, the `protocol/contracts/src` folder of a
 *   `git archive` of Jelly's default branch, inside this repository's `.source-jelly/` so zod resolves), the
 *   declaration also passes Jelly's own `PluginDeclarationSchema`. CI has no export, so that case is skipped there.
 */
import { pathToFileURL } from "node:url"
import { describe, expect, it } from "vitest"
import { ASSERTABLE_ACTIONS, CLEANUP_ACTION, DECLARED_ACTIONS, PERMISSION_ONLY, READ_ACTION, TOOLS, actionOf } from "../../src/domain/actions.js"
import type { ToolName } from "../../src/domain/contract.js"
import { loadOptions } from "../../src/options.js"
import { defaultRules, effectOf } from "../../src/permissions.js"
import { SKILL_IDS } from "../../src/skills.js"
import { sourceMethods } from "../../src/sources/index.js"
import { toolHandlers } from "../../src/tools/registry.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingsProblems } from "../support/jelly-settings.js"

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
type SignIn = { id: string; label: string; integration: string; scopes: string[]; needed: string[] }
const jelly = manifest.jelly as Declaration & { tools: DeclaredTool[]; signIns: SignIn[]; contributes: { settings: PluginSetting[] } }

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
    edit: { path: "a.ipynb", ops: [{ op: "create" }] },
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
    await runTool(name, input, call(`call_${name}`), runner)
    out.set(name, permission.requests.slice(before).map((request) => request.action))
  }
  return out
}

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with the effects the plugin's own default rules give", () => {
    const problems = declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), registered: DECLARED_ACTIONS, actionPermissions: true })
    expect(problems).toEqual([])
  })

  it("declares the 20 tools and the two permission-only reads, 22 entries, 14 read-only", () => {
    expect(jelly.tools.map((tool) => tool.permission).sort()).toEqual([...DECLARED_ACTIONS].sort())
    expect(jelly.tools).toHaveLength(22)
    expect(jelly.tools.filter((tool) => tool.readOnly)).toHaveLength(14)
    for (const tool of TOOLS) {
      const declared = jelly.tools.find((entry) => entry.permission === actionOf(tool.name))!
      expect(declared.name, tool.name).toBe(actionOf(tool.name))
      expect(declared.effect).toBe("allow")
      expect(declared.readOnly === true, tool.name).toBe(tool.class === "read")
    }
    for (const entry of PERMISSION_ONLY) {
      expect(jelly.tools.find((tool) => tool.permission === entry.action)).toEqual({ name: entry.action, permission: entry.action, effect: "allow", readOnly: true, note: entry.note })
      expect(TOOLS.some((tool) => actionOf(tool.name) === entry.action), `${entry.action} has no tool of its own`).toBe(false)
    }
  })

  it("asserted equals declared: each tool asserts exactly its own action, once, before anything runs", async () => {
    const asserted = await assertedActions()
    // Package-neutral: a built tool also asserts colab.read for its provider reads; its own action comes first, once.
    for (const tool of TOOLS) {
      const actions = asserted.get(tool.name as ToolName) ?? []
      expect(actions[0], tool.name).toBe(actionOf(tool.name))
      expect(actions.filter((action) => action !== READ_ACTION), tool.name).toEqual([actionOf(tool.name)])
    }
    const all = new Set([...[...asserted.values()].flat(), READ_ACTION, ...sourceMethods().map((method) => method.action)])
    expect([...all].sort()).toEqual([...DECLARED_ACTIONS].sort())
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("declares one Google sign-in with the sorted union of every scope, the host client and the sign-in codes", () => {
    expect(jelly.signIns).toHaveLength(1)
    const signIn = jelly.signIns[0]!
    expect(signIn).toMatchObject({ id: "google-colab", integration: "colab-*", needed: ["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"] })
    expect(signIn.scopes).toEqual([...new Set(signIn.scopes)].sort())
    expect(signIn.scopes).toEqual([
      "https://www.googleapis.com/auth/cloud-platform",
      "https://www.googleapis.com/auth/colaboratory",
      "https://www.googleapis.com/auth/colaboratory.readonly",
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/userinfo.email",
      "openid",
    ])
  })

  it("states the cost and the admin step within Jelly's limits", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
    expect(jelly.cost).toMatch(/released after 20 min/)
    expect(jelly.cost).toMatch(/compute cost cap/)
  })

  it("declares access with Jelly's own words and the parser's default", () => {
    const settings = jelly.contributes.settings
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settings[0]!.choices).toEqual(ACCESS_CHOICES)
    expect(settings[0]!.default).toBe(loadOptions({}).access)
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
  const reads = new Set([...TOOLS.filter((tool) => tool.class === "read").map((tool) => actionOf(tool.name)), ...PERMISSION_ONLY.map((entry) => entry.action)])
  const expected: Record<string, { read: string; change: string }> = {
    all: { read: "allow", change: "allow" },
    "ask-changes": { read: "allow", change: "ask" },
    "read-only": { read: "allow", change: "deny" },
  }
  for (const access of ["all", "ask-changes", "read-only"] as const) {
    it(`at ${access}: reads (colab.read and colab.probe included) allow; changes follow the choice; colab.cleanup takes the namespace rule`, () => {
      for (const action of ASSERTABLE_ACTIONS) {
        const want = reads.has(action) ? expected[access]!.read : expected[access]!.change
        expect(jellyEffect(access, action), `${action} at ${access}`).toBe(want)
      }
      expect(jellyEffect(access, CLEANUP_ACTION)).toBe(expected[access]!.change)
    })

    it(`at ${access}: the plugin's own default rules agree with Jelly for every tool action; colab.cleanup asks, and is denied at read-only as in Jelly`, () => {
      const rules = [{ action: "*", resource: "*", effect: "allow" as const }, ...defaultRules(access)]
      for (const action of DECLARED_ACTIONS) expect(effectOf(rules, action), `${action} at ${access}`).toBe(jellyEffect(access, action))
      expect(effectOf(rules, CLEANUP_ACTION)).toBe(access === "read-only" ? "deny" : "ask")
    })
  }
})

const contracts = process.env.JELLY_CONTRACTS

describe("Jelly's own PluginDeclarationSchema", () => {
  it.skipIf(!contracts)("accepts the declaration, with no unknown field, with and without the sources block", async () => {
    const module = (await import(pathToFileURL(`${contracts}/plugin-contract.ts`).href)) as {
      PluginDeclarationSchema: { safeParse(value: unknown): { success: boolean; error?: { issues: { path: unknown[]; message: string }[] } } }
      unknownDeclarationFields(value: unknown): string[]
    }
    const issues = (value: unknown) => {
      const result = module.PluginDeclarationSchema.safeParse(value)
      return result.success ? [] : (result.error?.issues ?? []).map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    }
    expect(issues(jelly)).toEqual([])
    expect(issues({ ...jelly, sources: (manifest as { sources?: unknown }).sources })).toEqual([])
    expect(module.unknownDeclarationFields(jelly)).toEqual([])
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
