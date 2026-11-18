// Package G's docs say what the code guarantees and no more (design §16): the guarantee's three tiers word for word in
// docs/safety.md too (test/unit/docs.test.ts pins the README and the skill); every live check named, with L1 as the
// gate for consumer execution; the plan-then-commit shape in the README; every option documented; and every relative
// link and anchor resolving.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** The three tiers' bullets, whitespace collapsed, as test/unit/docs.test.ts reads them. */
function tiers(file: string): string[] {
  const text = read(file)
  const start = text.indexOf("- **Guaranteed:**")
  if (start === -1) return []
  return text
    .slice(start)
    .split(/\n\n/)[0]!
    .split(/\n(?=- \*\*)/)
    .map((bullet) => bullet.replace(/\s+/g, " ").trim())
}

const LIVE_CHECKS = ["L1", "L2", "L3", "L4", "L5", "L6", "L7", "L7b", "L7c", "L8", "L8b", "L9", "L10", "L11", "L12", "L13", "L14", "L15", "L16", "L17"]

describe("docs/safety.md", () => {
  it("carries the guarantee word for word", () => {
    expect(tiers("docs/safety.md")).toEqual(tiers("docs/v1-design.md"))
  })

  it("lists every live check in its table, and says L1 decides whether consumer execution ships", () => {
    const table = read("docs/safety.md").split("## Live checks not yet run")[1]!
    for (const check of LIVE_CHECKS) expect(table, check).toMatch(new RegExp(`^\\| (\\*\\*)?${check}(\\*\\*)? \\|`, "m"))
    expect(table).toMatch(/decides whether consumer execution ships enabled/)
  })

  it("names the sources' limits: retention, this machine's ledger, the detached run, the sweep's write, the synthetic owner, colab.jobs", () => {
    const limits = read("docs/safety.md").split("## Known limits")[1]!.split("## Live checks")[0]!
    for (const phrase of ["`ledgerDays` (90)", "another computer", "`detached`", "the only write a source read makes", "`colab:account:<alias>`", "`colab.jobs`", "L13", "L11", "L8b", "L17"]) expect(limits, phrase).toContain(phrase)
  })
})

describe("the README", () => {
  it("names every live check and the L1 gate", () => {
    const text = read("README.md")
    for (const check of LIVE_CHECKS) expect(text, check).toContain(check)
    expect(text).toMatch(/L1 decides whether running code on consumer Colab ships enabled/)
  })

  it("shows colab_plan with the action's parameters under params, and the commit with only the planId", () => {
    const text = read("README.md")
    expect(text).toMatch(/colab_plan\(\{ "action": "runtime\.create", "params": \{/)
    expect(text).toMatch(/colab_write\(\{ "planId": "[^"]+" \}\)/)
  })

  it("says named accounts are read-only until access is write", () => {
    for (const file of ["README.md", "skills/opencode-colab/SKILL.md", "docs/configuration.md"]) expect(read(file), file).toMatch(/named account[^.]*read-only until/i)
  })
})

describe("docs/configuration.md", () => {
  it("documents every option the plugin takes", () => {
    const text = read("docs/configuration.md")
    const keys = Object.keys(loadOptions({})).concat(["oauthClient", "redirectUri", "callbackPort", "rates"])
    for (const key of keys) expect(text, key).toContain(`\`${key}\``)
  })
})

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
const slug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^\p{L}\p{N} -]/gu, "")
    .replace(/ /g, "-")

describe("links", () => {
  const files = ["README.md", "CHANGELOG.md", ...readdirSync(join(ROOT, "docs")).map((file) => `docs/${file}`), "skills/opencode-colab/SKILL.md", "skills/opencode-colab-notebooks/SKILL.md"].filter((file) => file.endsWith(".md"))

  it("resolve to files and headings in the repository", () => {
    const problems: string[] = []
    for (const file of files) {
      for (const match of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = match[1]!
        if (/^[a-z]+:/i.test(target)) continue
        const [path, anchor] = target.split("#") as [string, string | undefined]
        const resolved = path === "" ? file : normalize(join(dirname(file), path))
        if (!existsSync(join(ROOT, resolved))) {
          problems.push(`${file}: ${target} (no file)`)
          continue
        }
        if (anchor !== undefined && resolved.endsWith(".md")) {
          const anchors = [...read(resolved).matchAll(/^#+ (.+)$/gm)].map((heading) => slug(heading[1]!))
          if (!anchors.includes(anchor)) problems.push(`${file}: ${target} (no heading)`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})
