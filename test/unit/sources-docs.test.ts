// Public editing-build documentation, local configuration and repository links.
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { dirname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { loadEditingOptions } from "../../src/editing/options.js"
import { loadOptions } from "../../src/options.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

it("explains L1, the local path and permission rules, and does not advertise full tools", () => {
  expect(read("README.md")).toMatch(/L1; it is outside this build/)
  expect(read("docs/safety.md")).toContain("Symbolic links".toLowerCase())
  expect(read("docs/scripting.md")).toContain("Only the read tools `find` and `notebook`")
  for (const file of ["README.md", "docs/scripting.md", "docs/safety.md"]) expect(read(file), file).not.toMatch(/colab_(?:run|plan|write|download)\(/)
})

it("documents all accepted local options and the refusal of every latent provider option", () => {
  const text = read("docs/configuration.md")
  const local = Object.keys(loadEditingOptions({}))
  for (const key of local) expect(text, key).toContain(`\`${key}\``)
  const refused = [...Object.keys(loadOptions({})), "oauthClient", "redirectUri", "callbackPort", "rates"].filter((key) => !local.includes(key))
  for (const key of refused) expect(text, key).toContain(`\`${key}\``)
  expect(text).toContain("OPTIONS_INVALID")
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
  const files = ["README.md", "CHANGELOG.md", ...readdirSync(join(ROOT, "docs")).map((file) => `docs/${file}`), "skills/colab/SKILL.md", "skills/colab-notebooks/SKILL.md"].filter((file) => file.endsWith(".md"))

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
