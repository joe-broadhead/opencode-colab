// The one error table: the message shape, the generated docs, and every code raised in src/ being in the table.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ColabError, ERROR_CODES, renderErrorDoc, WARNING_CODES } from "../../src/domain/errors.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("the error table", () => {
  it("writes `CODE: What happened. Next step: What to do.`, with the table's next step unless the raise site gives one", () => {
    expect(new ColabError("SKILLS_INVALID").message).toBe("SKILLS_INVALID: A bundled skill is missing or malformed. Next step: Reinstall the plugin.")
    const error = new ColabError("OPTIONS_INVALID", "Bad option", { next: "Fix it" })
    expect(error.message).toBe("OPTIONS_INVALID: Bad option. Next step: Fix it.")
    expect(error.state).toBe("refused")
  })

  it("docs/errors.md is what the table generates", () => {
    expect(read("docs/errors.md")).toBe(renderErrorDoc())
  })

  it("every code a source file names is in the table", () => {
    const known = new Set<string>([...ERROR_CODES, ...WARNING_CODES])
    const foreign = /^(SESSION_UNKNOWN|SESSION_AGENT_REQUIRED|PERMISSION_DENIED|ACCOUNT_UNKNOWN|XDG_STATE_HOME)$/
    const named = walk("src").flatMap((file) => [...read(file).matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`:]/g)].map((match) => [file, match[1]!] as const))
    expect(named.filter(([, code]) => !known.has(code) && !foreign.test(code))).toEqual([])
  })
})
