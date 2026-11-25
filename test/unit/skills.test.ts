// The bundled skills: every skills/<name>/SKILL.md read by directory scan, its YAML frontmatter, the description
// budget, and every tools.colab.<method> a skill names is declared.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { parse as parseYaml } from "yaml"
import { readSkills, type SkillFile } from "../../src/skills.js"
import { manifest } from "../../src/manifest.js"

const methods = new Set(Object.keys(manifest.methods))
const declaredTools = (text: string): string[] => [...text.matchAll(/tools\.colab\.([a-z_]+)/g)].map((match) => match[1]!)
const made: string[] = []
const temp = (): string => {
  const directory = mkdtempSync(join(tmpdir(), "colab-skills-"))
  made.push(directory)
  return directory
}
afterAll(() => {
  for (const directory of made) rmSync(directory, { recursive: true, force: true })
})

const frontmatterOf = (skill: SkillFile): unknown => {
  const text = readFileSync(skill.path, "utf8")
  const front = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1]
  expect(front, skill.id).toBeDefined()
  return parseYaml(front!)
}

const writeSkill = (root: string, id: string, description: string): void => {
  const directory = join(root, "skills", id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\nbody\n`)
}

describe("skills", () => {
  it("are the main skill and the notebooks skill, read by directory scan", () => {
    expect(readSkills().map((skill) => skill.id)).toEqual(["colab", "colab-notebooks"])
  })

  for (const skill of readSkills()) {
    it(`${skill.id} has a name, a description within 300 characters and only declared tools`, () => {
      expect(skill.name).toBe(skill.id)
      expect(skill.path.endsWith(join("skills", skill.id, "SKILL.md"))).toBe(true)
      expect(skill.description.length).toBeLessThanOrEqual(300)
      expect(skill.content.length).toBeGreaterThan(0)
      for (const tool of declaredTools(skill.content)) expect(methods.has(tool), `${skill.id} names tools.colab.${tool}`).toBe(true)
    })
  }

  it("parses the frontmatter with YAML and registers the name and description it reads", () => {
    for (const skill of readSkills()) {
      const parsed = frontmatterOf(skill) as { name?: unknown; description?: unknown }
      expect(parsed.name, skill.id).toBe(skill.id)
      expect(parsed.description, skill.id).toBe(skill.description)
      expect(skill.description.trim(), skill.id).not.toBe("")
      for (const marker of [">", "|", ">-", "|-", ">+", "|+"]) expect(skill.description.trim(), skill.id).not.toBe(marker)
    }
  })

  it("takes a block scalar's text, not its marker", () => {
    const root = temp()
    writeSkill(root, "colab", ">\n  A folded\n  description.")
    const [skill] = readSkills(join(root, "skills"))
    expect(skill?.description.trim()).toBe("A folded description.")
  })

  it("refuses a bare block marker, a missing description and a name that is not its directory", () => {
    const root = temp()
    writeSkill(root, "colab", ">")
    expect(() => readSkills(join(root, "skills"))).toThrow(/no frontmatter description/)
    writeSkill(root, "colab", '""')
    expect(() => readSkills(join(root, "skills"))).toThrow(/no frontmatter description/)
    writeSkill(root, "colab", "x")
    const other = join(root, "skills", "colab-notebooks")
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, "SKILL.md"), "---\nname: colab\ndescription: x\n---\nbody\n")
    expect(() => readSkills(join(root, "skills"))).toThrow(/not its directory/)
  })

  it("refuses invalid YAML, which is how a plain description with a colon fails", () => {
    const root = temp()
    const directory = join(root, "skills", "colab")
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "---\nname: colab\ndescription: find files: read cells\n---\nbody\n")
    expect(() => readSkills(join(root, "skills"))).toThrow(/not valid YAML/)
  })
})
