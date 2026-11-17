// The `access` → default-rules block (design §7.1, §10).
import { describe, expect, it } from "vitest"
import { CHANGE_TOOL_ACTIONS, CLEANUP_ACTION, PERMISSION_ONLY, READ_TOOL_ACTIONS } from "../../src/domain/actions.js"
import { defaultRules, effectOf, insertDefaults, type Rule, unguardedAgents } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }
const effects = { all: "allow", "ask-changes": "ask", "read-only": "deny" } as const

describe("the default rules", () => {
  for (const [access, change] of Object.entries(effects) as [keyof typeof effects, string][]) {
    it(`at ${access}: reads and the permission-only reads allow, changes ${change}, colab.cleanup ${access === "read-only" ? "denied" : "asks"}`, () => {
      const rules = [BASE, ...defaultRules(access)]
      for (const action of [...READ_TOOL_ACTIONS, ...PERMISSION_ONLY.map((entry) => entry.action)]) expect(effectOf(rules, action, "work:colaboratory.runtimes.list"), action).toBe("allow")
      for (const action of CHANGE_TOOL_ACTIONS) expect(effectOf(rules, action, "work:runtime:oc-01"), action).toBe(change)
      expect(effectOf(rules, "colab.some_later_tool")).toBe(change)
      expect(effectOf(rules, CLEANUP_ACTION)).toBe(access === "read-only" ? "deny" : "ask")
    })
  }

  it("goes right after the base allow, once, so the user's later rules win", () => {
    const user: Rule = { action: "colab.run", resource: "work:runtime:*", effect: "deny" }
    const inserted = insertDefaults([BASE, user], defaultRules())
    expect(inserted[0]).toEqual(BASE)
    expect(inserted.at(-1)).toEqual(user)
    expect(insertDefaults(inserted, defaultRules())).toEqual(inserted)
    expect(effectOf(inserted, "colab.run", "work:runtime:oc-01")).toBe("deny")
    expect(effectOf(inserted, "colab.run", "home:runtime:oc-02")).toBe("allow")
  })

  it("names agents without the block that would run an unknown Colab tool unasked", () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules("ask-changes")) },
      { id: "custom", permissions: [BASE] },
      { id: "plan", permissions: [BASE, { action: "*", resource: "*", effect: "deny" as const }] },
    ]
    expect(unguardedAgents(agents, "ask-changes")).toEqual(["custom"])
  })
})
