/**
 * The `jelly` section of package.json, which Jelly reads without loading the plugin. The shared kit checks it against
 * Jelly's plugin authors' standard; the tests below add what only Colab declares. No tool is declared until the Day 0
 * contract lands.
 */
import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"
import { defaultRules } from "../../src/permissions.js"
import { SKILL_IDS } from "../../src/skills.js"
import { type Declaration, type DeclaredTool, declarationProblems, docProblems, effectFromRules, lineProblems, readPackage } from "../support/jelly-kit.js"
import { ACCESS_CHOICES, type PluginSetting, settingsProblems } from "../support/jelly-settings.js"

const ROOT = new URL("../../", import.meta.url)
const manifest = readPackage(ROOT)
type SignIn = { id: string; integration: string; scopes: string[]; needed: string[] }
const jelly = manifest.jelly as Declaration & { tools: DeclaredTool[]; signIns: SignIn[]; contributes: { settings: PluginSetting[] } }

describe("the jelly declaration", () => {
  it("follows the plugin authors' standard, with no tool declared yet", () => {
    expect(declarationProblems(ROOT, { effectOf: effectFromRules(defaultRules()), actionPermissions: true })).toEqual(["jelly.tools is empty"])
  })

  it("declares the skills the plugin registers", () => {
    expect(jelly.skills).toEqual([...SKILL_IDS])
  })

  it("declares one Google sign-in with the sorted union of every scope, the host client and the sign-in codes", () => {
    expect(jelly.signIns).toHaveLength(1)
    const signIn = jelly.signIns[0]!
    expect(signIn).toMatchObject({ id: "google-colab", integration: "colab-*", needed: ["AUTH_REQUIRED", "AUTH_SCOPE_MISSING"] })
    expect(signIn.scopes).toEqual([...new Set(signIn.scopes)].sort())
  })

  it("states the cost and the admin step within Jelly's limits", () => {
    expect(lineProblems("cost", jelly.cost, 300)).toEqual([])
    expect(lineProblems("admin", jelly.admin, 200)).toEqual([])
  })

  it("declares access with Jelly's own words and the parser's default", () => {
    const settings = jelly.contributes.settings
    expect(settingsProblems(settings)).toEqual([])
    expect(settings.map((setting) => setting.key)).toEqual(["access"])
    expect(settings[0]!.choices).toEqual(ACCESS_CHOICES)
    expect(settings[0]!.default).toBe(loadOptions({}).access)
  })
})

describe("docs/jelly.md", () => {
  it("follows the plugin authors' standard", () => {
    expect(docProblems(ROOT)).toEqual([])
  })
})
