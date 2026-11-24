// The docs that pin the contract: every file under src/ and test/ has exactly one owner in docs/v1-design.md's File
// ownership table and no two owners' patterns overlap; and the editing-only guarantee's three tiers are word for word
// the same in docs/v1-design.md, the README and the opencode-colab skill.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else out.push(path)
  }
  return out
}

/** `a/{b,c}.ts` → `a/b.ts`, `a/c.ts`. */
const expand = (pattern: string): string[] => {
  const match = /\{([^}]*)\}/.exec(pattern)
  return match ? match[1]!.split(",").flatMap((part) => expand(pattern.replace(match[0], part))) : [pattern]
}
const regex = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`)

/** Each owner's path patterns: the backticked tokens of its row that name a path under src/ or test/. */
function owners(): Map<string, string[]> {
  const section = read("docs/v1-design.md").split("## File ownership")[1]!.split("\n## ")[0]!
  const rows = section.split("\n").filter((line) => /^\| \*\*/.test(line))
  return new Map(
    rows.map((row) => {
      const [, owner, files] = row.split("|").map((cell) => cell.trim())
      const patterns = [...files!.matchAll(/`([^`]+)`/g)].map((match) => match[1]!).filter((token) => /^(src|test)\//.test(token)).flatMap(expand)
      return [owner!.replaceAll("*", ""), patterns]
    }),
  )
}

describe("file ownership", () => {
  const table = owners()

  it("lists Day 0, the family kit and packages A to G", () => {
    expect([...table.keys()]).toEqual(["Day 0", "Family kit", "A. Auth", "B. Runtime transport", "C. Notebooks", "D. Execution", "E. Enterprise", "F. Cost, cleanup, status", "G. Sources, skills, docs"])
  })

  it("gives every file under src/ and test/ exactly one owner", () => {
    const files = [...walk("src"), ...walk("test")]
    const problems = files.flatMap((file) => {
      const found = [...table].filter(([, patterns]) => patterns.some((pattern) => regex(pattern).test(file))).map(([owner]) => owner)
      return found.length === 1 ? [] : [`${file}: ${found.length === 0 ? "no owner" : found.join(" and ")}`]
    })
    expect(problems).toEqual([])
  })

  it("has no two owners whose patterns can name the same new file", () => {
    const problems: string[] = []
    for (const [owner, patterns] of table) {
      for (const pattern of patterns) {
        // A file a package would add under this pattern must match only this owner.
        const sample = pattern.replaceAll("*", "new-file")
        const others = [...table].filter(([other, theirs]) => other !== owner && theirs.some((their) => regex(their).test(sample))).map(([other]) => other)
        if (others.length) problems.push(`${pattern} (${owner}) also matches ${others.join(", ")}`)
      }
    }
    expect(problems).toEqual([])
  })

  it("keeps fakes in one folder: Day 0's index and each package's own prefix", () => {
    expect(walk("test").filter((file) => file.startsWith("test/fake/"))).toEqual([])
    const prefixes = [...table.values()].flat().filter((pattern) => pattern.startsWith("test/fakes/"))
    expect(prefixes.sort()).toEqual(["test/fakes/auth-*.ts", "test/fakes/cost-*.ts", "test/fakes/enterprise-*.ts", "test/fakes/execution-*.ts", "test/fakes/index.ts", "test/fakes/notebooks-*.ts", "test/fakes/runtime-*.ts", "test/fakes/sources-*.ts"])
  })
})

/** The three tiers' bullets, whitespace collapsed. */
function tiers(file: string): string[] {
  const text = read(file)
  const start = text.indexOf("- **Guaranteed:**")
  if (start === -1) return []
  const block = text.slice(start).split(/\n\n/)[0]!
  return block.split(/\n(?=- \*\*)/).map((bullet) => bullet.replace(/\s+/g, " ").trim())
}

describe("the editing-only guarantee", () => {
  const canonical = tiers("docs/v1-design.md")

  it("has three tiers in docs/v1-design.md: guaranteed, best effort, cannot see", () => {
    expect(canonical.map((bullet) => /^- \*\*([^:]+):\*\*/.exec(bullet)?.[1])).toEqual(["Guaranteed", "Best effort", "Cannot see"])
    expect(canonical[1]).toContain("checks the destination hash and rechecks the opened directory's identity before publishing")
    expect(canonical[1]).toContain("narrow the cross-process window")
  })

  for (const file of ["README.md", "docs/safety.md", "skills/opencode-colab/SKILL.md"]) {
    it(`is word for word the same in ${file}`, () => {
      expect(tiers(file)).toEqual(canonical)
    })
  }
})
