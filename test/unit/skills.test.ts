import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { NAMESPACE_DESCRIPTION as EDITING_NAMESPACE, SURFACE_TOOLS } from "../../src/editing/tools.js"
import { parseSkill, SKILL_IDS } from "../../src/skills.js"
import { NAMESPACE_DESCRIPTION as LATENT_NAMESPACE } from "../../src/tools.js"

const text = (id: string) => readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")

describe("skills", () => {
  it("are the main skill and the notebooks skill", () => {
    expect([...SKILL_IDS]).toEqual(["colab", "colab-notebooks"])
  })

  for (const id of SKILL_IDS) {
    it(`${id} has exactly a name and a one-line description`, () => {
      const skill = parseSkill(id, text(id))
      expect(skill.name).toBe(id)
      expect(skill.description.length).toBeGreaterThan(40)
    })

    it(`${id} has a description within the 300-character budget`, () => {
      const skill = parseSkill(id, text(id))
      expect(skill.description.length, id).toBeLessThanOrEqual(300)
    })

    it(`${id} names only tools the plugin registers`, () => {
      const named = parseSkill(id, text(id)).content.match(/\bcolab_[a-z][a-z0-9_]*/g) ?? []
      const known = new Set(SURFACE_TOOLS.map((tool) => `colab_${tool.name}` as string))
      expect(named.filter((name) => !known.has(name))).toEqual([])
    })
  }

  it("keeps both namespace lines within the 400-character budget", () => {
    expect(LATENT_NAMESPACE.length).toBe(342)
    expect(EDITING_NAMESPACE.length).toBe(149)
    expect(LATENT_NAMESPACE.length).toBeLessThanOrEqual(400)
    expect(EDITING_NAMESPACE.length).toBeLessThanOrEqual(400)
  })

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("colab", "---\nname: colab\ndescription: x\nextra: y\n---\nbody")).toThrow(/^SKILLS_INVALID: /)
  })
})
