// The bundled skills: the names, the description budget, and every tools.colab.<method> a skill names is declared.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parseSkill, SKILL_IDS, skillPath } from "../../src/skills.js"
import { manifest } from "../../src/manifest.js"

const methods = new Set(Object.keys(manifest.methods))
const declaredTools = (text: string): string[] => [...text.matchAll(/tools\.colab\.([a-z_]+)/g)].map((match) => match[1]!)

describe("skills", () => {
  it("are the main skill and the notebooks skill", () => {
    expect(SKILL_IDS).toEqual(["colab", "colab-notebooks"])
  })

  for (const id of SKILL_IDS) {
    it(`${id} has a name, a description within 300 characters and only declared tools`, () => {
      const text = readFileSync(skillPath(id), "utf8")
      const skill = parseSkill(id, text)
      expect(skill.name).toBe(id)
      expect(skill.description.length).toBeLessThanOrEqual(300)
      expect(skill.content.length).toBeGreaterThan(0)
      for (const tool of declaredTools(skill.content)) expect(methods.has(tool), `${id} names tools.colab.${tool}`).toBe(true)
    })
  }

  it("keeps the namespace line within 400 characters", () => {
    expect(manifest.plugin.summary.length).toBeLessThanOrEqual(400)
  })

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("colab", "---\nname: colab\ndescription: x\nowner: y\n---\nbody\n")).toThrow(/frontmatter|needs exactly/)
  })
})
