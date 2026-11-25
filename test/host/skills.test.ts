// The real OpenCode 2.4.1 embedded host, on an empty project: OpenCode discovers `<project>/skills/` itself, so using
// the repository root would let the test pass without `registerSkills`. The skills must come from the plugin's own
// transform, and each served description must be the YAML text, not a `>` or `|` marker.
import "./isolate.js"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { OpenCode } from "@opencode/sdk"
import type { Plugin } from "@opencode/plugin"
import { load, resolve } from "@opencode/plugin/host"
import { waitForActivation } from "@we-the-rebel-alliance/plugin-contract/kit"
import { parse as parseYaml } from "yaml"

const root = fileURLToPath(new URL("../..", import.meta.url))

/** The real host's domains this test reads, as `@opencode/plugin` exposes them to a plugin. */
interface Host {
  readonly sessions: {
    create(input: Record<string, unknown>): Promise<{ readonly id: string }>
    prompt(input: Record<string, unknown>): Promise<unknown>
  }
  readonly plugin: {
    list(input: Record<string, unknown>): Promise<{ readonly data: readonly { readonly id?: string }[] }>
  }
  readonly skill: {
    list(input: Record<string, unknown>): Promise<{
      readonly data: readonly { readonly id: string; readonly name: string; readonly description?: string; readonly path: string; readonly content: string }[]
    }>
  }
  close(): Promise<void>
}

describe("the real host skill registration", () => {
  test("registers every skills/<name>/SKILL.md after load, on an empty project", async () => {
    const entry = resolve({ directory: root }).server
    expect(entry, "the package has no server entry").toBeDefined()
    const module = (await load(entry!)) as { readonly default?: Plugin.Plugin }
    const definition = module.default
    expect(definition, "the server entry exports no Plugin.define value").toBeDefined()

    const ids = readdirSync(join(root, "skills"), { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .map((item) => item.name)
      .sort()
    expect(ids.length).toBeGreaterThan(0)

    const project = mkdtempSync(join(tmpdir(), "colab-skill-project-"))
    try {
      const host = (await OpenCode.create({
        plugins: [definition!],
        config: { directory: project },
        app: { name: "opencode", version: "2.4.1" },
        log: { level: "error", emit: () => undefined },
      })) as unknown as Host

      try {
        const session = await host.sessions.create({ location: { directory: project }, agent: "build", permissions: [] })
        await host.sessions.prompt({ sessionID: session.id, text: "activate the skill registration", delivery: "queue" }).catch(() => undefined)
        await waitForActivation({
          isActive: async () => {
            const list = await host.plugin.list({ location: { directory: project } }).catch(() => undefined)
            return list?.data.some((item) => item.id === definition!.id) ?? false
          },
          timeoutMs: 20_000,
        })
        const answer = await host.skill.list({ location: { directory: project } })
        for (const id of ids) {
          const skill = answer.data.find((candidate) => candidate.id === id)
          expect(skill, `the host did not register the ${id} skill`).toBeDefined()
          expect(skill!.name).toBe(id)
          expect(skill!.path).toBe(join(root, "skills", id, "SKILL.md"))
          expect(skill!.content.trim().length).toBeGreaterThan(0)
          const text = readFileSync(skill!.path, "utf8")
          const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
          expect(frontmatter, `the ${id} skill has no frontmatter`).not.toBeNull()
          const parsed = parseYaml(frontmatter![1] ?? "") as { readonly description?: unknown }
          expect(typeof parsed.description, `the ${id} skill has no YAML description`).toBe("string")
          const expected = parsed.description as string
          expect(expected.trim(), `the ${id} skill has an empty description`).not.toBe("")
          for (const marker of [">", "|", ">-", "|-", ">+", "|+"]) {
            expect(expected.trim(), `the ${id} skill registers the block marker ${marker}, not its text`).not.toBe(marker)
          }
          expect(skill!.description, `the ${id} skill description is not the YAML text`).toBe(expected)
        }
      } finally {
        await host.close()
      }
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  }, 60_000)
})
