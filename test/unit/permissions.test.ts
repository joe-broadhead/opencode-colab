// The `access` → default-rules block: until tools exist, one namespace rule with the change effect.
import { describe, expect, it } from "vitest"
import { defaultRules, effectOf, insertDefaults, type Rule, unguardedAgents } from "../../src/permissions.js"

const BASE: Rule = { action: "*", resource: "*", effect: "allow" }

describe("the default rules", () => {
  it("give every colab action the access choice's effect", () => {
    expect(defaultRules("all")).toEqual([{ action: "colab.*", resource: "*", effect: "allow" }])
    expect(defaultRules("ask-changes")).toEqual([{ action: "colab.*", resource: "*", effect: "ask" }])
    expect(defaultRules("read-only")).toEqual([{ action: "colab.*", resource: "*", effect: "deny" }])
  })

  it("go right after the base allow, once, so the user's later rules win", () => {
    const user: Rule = { action: "colab.run", resource: "*", effect: "deny" }
    const inserted = insertDefaults([BASE, user], defaultRules())
    expect(inserted).toEqual([BASE, ...defaultRules(), user])
    expect(insertDefaults(inserted, defaultRules())).toEqual(inserted)
    expect(effectOf(inserted, "colab.run")).toBe("deny")
  })

  it("name agents without the block that would run an unknown Colab tool unasked", () => {
    const agents = [
      { id: "build", permissions: insertDefaults([BASE], defaultRules("ask-changes")) },
      { id: "custom", permissions: [BASE] },
    ]
    expect(unguardedAgents(agents, "ask-changes")).toEqual(["custom"])
  })
})
