import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { SURFACE_TOOLS } from "../../src/editing/tools.js"
import { parseSkill, SKILL_IDS } from "../../src/skills.js"

const text = (id: string) => readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")

describe("skills", () => {
  it("are the main skill and the notebooks skill", () => {
    expect([...SKILL_IDS]).toEqual(["opencode-colab", "opencode-colab-notebooks"])
  })

  for (const id of SKILL_IDS) {
    it(`${id} has exactly a name and a one-line description`, () => {
      const skill = parseSkill(id, text(id))
      expect(skill.name).toBe(id)
      expect(skill.description.length).toBeGreaterThan(40)
    })

    it(`${id} names only tools the plugin registers`, () => {
      const named = parseSkill(id, text(id)).content.match(/\bcolab_[a-z][a-z0-9_]*/g) ?? []
      const known = new Set(SURFACE_TOOLS.map((tool) => `colab_${tool.name}` as string))
      expect(named.filter((name) => !known.has(name))).toEqual([])
    })
  }

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("opencode-colab", "---\nname: opencode-colab\ndescription: x\nextra: y\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
  })
})
