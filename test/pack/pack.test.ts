/**
 * The packed tarball: `npm pack`, install it with lifecycle scripts disabled, and load `exports["./server"]`. The host
 * package is a one-function stub here; the real host runs in `test/host/` and in the kit's T1.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const WORK = mkdtempSync("/tmp/opencode/colab-pack-")
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const run = (command: string, args: readonly string[], cwd = ROOT) =>
  execFileSync(command, args, { cwd, encoding: "utf8", env: { ...process.env, npm_config_update_notifier: "false" } })

describe("the packed tarball", () => {
  test("installs and its server entry loads with the plugin's id and setup", () => {
    run("node", ["scripts/build.mjs"])
    const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", WORK])) as [{ filename: string }]
    const project = join(WORK, "consumer")
    mkdirSync(project, { recursive: true })
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "colab-pack-consumer", private: true, type: "module" }))
    run("npm", ["install", join(WORK, packed.filename), "--ignore-scripts", "--no-audit", "--no-fund"], project)

    // The host package is provided by OpenCode at runtime; this stub proves the entry loads without it.
    const host = join(project, "node_modules/@opencode/plugin")
    mkdirSync(host, { recursive: true })
    writeFileSync(join(host, "package.json"), JSON.stringify({ name: "@opencode/plugin", version: "2.4.1", type: "module", exports: { ".": "./index.js", "./*": "./*" } }))
    writeFileSync(join(host, "index.js"), "export const Plugin = { define: (definition) => definition }\nexport const Skill = { ID: { make: (value) => value }, Name: { make: (value) => value } }\n")

    const installed = join(project, "node_modules/@we-the-rebel-alliance/colab-plugin")
    const pkg = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as {
      exports: Record<string, string>
      files: string[]
      dependencies?: unknown
      peerDependencies?: unknown
      capabilities: { plugin: { name: string }; methods: Record<string, unknown> }
    }
    expect(pkg.exports["./server"]).toBe("./dist/index.js")
    expect(pkg.files).toContain("dist")
    expect(pkg.dependencies).toBeUndefined()
    expect(pkg.peerDependencies).toBeUndefined()
    expect(Object.keys(pkg.capabilities.methods)).toHaveLength(24)

    const probe = join(project, "probe.mjs")
    writeFileSync(probe, `const plugin = (await import("@we-the-rebel-alliance/colab-plugin/server")).default\nconsole.log(JSON.stringify({ id: plugin.id, setup: typeof plugin.setup }))\n`)
    const output = run(process.execPath, [probe], project)
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({ id: "colab", setup: "function" })
  })
})
