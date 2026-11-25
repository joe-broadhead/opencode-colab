// The bundled skills: the names, the description budget, and every tools.colab.<method> a skill names is declared.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
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

  it("is valid YAML whose name and description are the ones the parser registers", () => {
    for (const id of SKILL_IDS) {
      const text = readFileSync(skillPath(id), "utf8")
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]
      const parsed = parseYaml(front!) as { name?: unknown; description?: unknown }
      const skill = parseSkill(id, text)
      expect(parsed.name, id).toBe(id)
      expect(parsed.description, id).toBe(skill.description)
      expect(parsed.description, id).not.toBe(">")
      expect(parsed.description, id).not.toBe("|")
      expect((parsed.description as string).length, id).toBeLessThanOrEqual(300)
    }
  })

  it("refuses a block scalar or an empty description", () => {
    for (const marker of [">", "|", ">-", "|+"]) {
      expect(() => parseSkill("colab", `---\nname: colab\ndescription: ${marker}\n---\nbody\n`), marker).toThrow(/block scalar/)
    }
    expect(() => parseSkill("colab", "---\nname: colab\ndescription: \n---\nbody\n")).toThrow(/one-line/)
    expect(() => parseSkill("colab", "---\nname: colab\ndescription: >\n  folded\n---\nbody\n")).toThrow(/frontmatter/)
  })

  it("refuses a skill with an unknown frontmatter key", () => {
    expect(() => parseSkill("colab", "---\nname: colab\ndescription: x\nowner: y\n---\nbody\n")).toThrow(/frontmatter|needs exactly/)
  })
})
