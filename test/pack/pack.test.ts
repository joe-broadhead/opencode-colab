/**
 * The packed tarball and the real install path:
 *
 * 1. `npm pack` holds the package whitelist, no runtime dependencies and the server export.
 * 2. A temp git checkout of the tarball's contents is installed with the real `opencode` 2.4.1 CLI
 *    (`opencode plugin add git+file://…#v0.0.0`) in an isolated HOME, and `opencode plugin list` shows it.
 * 3. The installed package in the CLI's cache is loaded by the contract's real embedded host, which answers `status`
 *    and lists the registered tools.
 * 4. The real 2.4.1 CLI service starts on a free port in the same isolated HOME and, after one session activates the
 *    plugin for an empty git project, `/api/skill` and `/api/command` answer with what the plugin registered. The
 *    project has no `skills/` folder of its own, so the ids can only come from the plugin.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"
import { parse as parseYaml } from "yaml"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const WORK = mkdtempSync(join(tmpdir(), "colab-pack-"))
afterAll(() => rmSync(WORK, { recursive: true, force: true }))

const run = (command: string, args: readonly string[], cwd = ROOT, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(command, args, { cwd, encoding: "utf8", env: { ...env, npm_config_update_notifier: "false" } })

function opencodeBinary(): string {
  const given = process.env.OPENCODE_BIN_2_4_1 ?? process.env.OPENCODE_BIN
  if (given) return given
  try {
    if (run("opencode", ["--version"]).trim() === "opencode v2.4.1") return "opencode"
  } catch {
    // fall through to the npm-installed stock binary
  }
  const stock = join(WORK, "stock")
  run("npm", ["install", "--prefix", stock, "--ignore-scripts", "--no-audit", "--no-fund", "@opencode/cli@2.4.1"])
  return join(stock, "node_modules", `@opencode/cli-${process.platform}-${process.arch}`, "bin", "opencode")
}

function isolated(base: string): NodeJS.ProcessEnv {
  const home = join(base, "home")
  // The test process runs inside an OpenCode session; its OPENCODE* variables would point the stock CLI at that
  // session's service instead of the isolated HOME. Keep only the base environment a runner needs.
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "TZ", "TERM", "SystemRoot", "ComSpec", "PATHEXT", "WINDIR"].includes(key)))
  const env = {
    ...baseEnv,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    TMPDIR: join(base, "tmp"),
  }
  for (const dir of [home, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR]) mkdirSync(dir, { recursive: true })
  return env
}

const PACKAGE = "@we-the-rebel-alliance/colab-plugin"

/** The 24 effective tool ids of the v0.0.0 surface. */
const TOOL_IDS = [
  "colab_status",
  "colab_probe",
  "colab_usage",
  "colab_specs",
  "colab_runtimes",
  "colab_find",
  "colab_notebook",
  "colab_files",
  "colab_execution",
  "colab_jobs",
  "colab_schedules",
  "colab_events_list",
  "colab_runtimes_read",
  "colab_plan_write",
  "colab_plan_delete",
  "colab_edit",
  "colab_run",
  "colab_cancel",
  "colab_upload",
  "colab_download",
  "colab_pause",
  "colab_write",
  "colab_delete",
  "colab_cleanup",
]

/** The pre-4a surface's 20 tools; `colab_plan` is the one the contract split in two. */
const OLD_TOOL_IDS = [
  "colab_status",
  "colab_specs",
  "colab_runtimes",
  "colab_find",
  "colab_notebook",
  "colab_files",
  "colab_execution",
  "colab_jobs",
  "colab_schedules",
  "colab_plan",
  "colab_events_list",
  "colab_runtimes_read",
  "colab_edit",
  "colab_run",
  "colab_cancel",
  "colab_upload",
  "colab_download",
  "colab_pause",
  "colab_write",
  "colab_delete",
]

/** A free loopback port: the service binds it, the test reads it from the CLI's own answer. */
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  const port = typeof address === "object" && address !== null ? address.port : 0
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** Read until `done` says so: the service answers before it has loaded the location's plugins. */
async function waitFor<T>(read: () => T, done: (value: T) => boolean, attempts = 240): Promise<T | undefined> {
  let value: T | undefined
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      value = read()
    } catch {
      value = undefined
    }
    if (value !== undefined && done(value)) return value
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return value
}

function installedPackage(cache: string): string {
  for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(entry.parentPath, entry.name)
    if (path.endsWith(join("node_modules", ...PACKAGE.split("/")))) return path
  }
  throw new Error(`the installed package is not under ${cache}`)
}

describe("the packed tarball", () => {
  test("installs with the real opencode CLI, answers status and registers its tools, skills and commands", async () => {
    run("npm", ["run", "bundle"])
    const [packed] = JSON.parse(run("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", WORK])) as [{ filename: string }]
    const tarball = join(WORK, packed.filename)

    const source = join(WORK, "source")
    mkdirSync(source, { recursive: true })
    run("tar", ["-xzf", tarball, "-C", source, "--strip-components=1"])
    const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8")) as {
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

    // The temp checkout is an install fixture: the host module must resolve from its cache, and a git dependency's
    // preparation runs npm install, so the fixture declares it as a dependency rather than a devDependency.
    const fixture = { ...pkg, dependencies: { "@opencode/plugin": "2.4.1" } } as Record<string, unknown>
    delete fixture.scripts
    delete fixture.devDependencies
    writeFileSync(join(source, "package.json"), `${JSON.stringify(fixture, null, 2)}\n`)
    run("git", ["init", "-q"], source)
    run("git", ["add", "-A"], source)
    run("git", ["-c", "user.name=pack-test", "-c", "user.email=pack-test@example.test", "commit", "-qm", "pack"], source)
    run("git", ["tag", "v0.0.0"], source)

    const base = join(WORK, "install")
    const home = isolated(base)
    // The stock CLI's `plugin add` writes `$HOME/.config` and `plugin list` reads it; its XDG overrides in 2.4.1 point
    // the two at different stores. HOME is already isolated, so the CLI calls use HOME alone; the host probe keeps XDG.
    const cliHome = { ...home }
    delete cliHome.XDG_CONFIG_HOME
    delete cliHome.XDG_DATA_HOME
    delete cliHome.XDG_CACHE_HOME
    delete cliHome.XDG_STATE_HOME
    const project = join(base, "project")
    mkdirSync(project, { recursive: true })
    run("git", ["init", "-q"], project)
    const binary = opencodeBinary()
    expect(run(binary, ["--version"], project, cliHome).trim()).toBe("opencode v2.4.1")
    const ref = `git+file://${source}#v0.0.0`
    const added = run(binary, ["plugin", "add", ref], project, cliHome)
    expect(added).toContain("installed")

    const installed = installedPackage(join(home.XDG_CACHE_HOME!, "opencode", "npm"))
    const probe = join(base, "probe.mjs")
    const kit = pathToFileURL(join(ROOT, "node_modules", "@we-the-rebel-alliance", "plugin-contract", "dist", "kit.js")).href
    writeFileSync(
      probe,
      `import { createHost } from ${JSON.stringify(kit)}\n` +
        `const run = await createHost({ directory: ${JSON.stringify(installed)}, version: "2.4.1", pluginId: "colab", options: { access: "all" } })\n` +
        `try { const answer = await run.call("status", {}); console.log(JSON.stringify({ ok: answer.ok, output: answer.ok ? answer.output : answer, tools: run.tools.map((tool) => tool.id), rpc: run.rpc })) } finally { await run.close() }\n`,
    )
    const output = JSON.parse(run(process.execPath, [probe], base, home).trim().split("\n").at(-1)!) as {
      ok: boolean
      output: Record<string, unknown>
      tools: string[]
      rpc: { id: string; methods: string[] }
    }
    expect(output.ok).toBe(true)
    expect(output.output).toMatchObject({ name: "colab", version: "0.0.0", state: "needs_sign_in" })
    expect([...output.tools].sort()).toEqual([...TOOL_IDS].sort())
    // Parity: every tool the pre-4a surface exposed survives, except the one the contract split into two plans.
    for (const id of OLD_TOOL_IDS.filter((tool) => tool !== "colab_plan")) expect(output.tools).toContain(id)
    expect(output.tools).not.toContain("colab_plan")
    expect(output.tools).toEqual(expect.arrayContaining(["colab_plan_write", "colab_plan_delete"]))
    expect(output.rpc.id).toBe("colab")

    // The real service, on a free port, in the same isolated HOME. A fresh service answers `/api/skill` with only the
    // built-ins; one session for the empty project makes OpenCode activate the location's plugins.
    const port = await freePort()
    run(binary, ["service", "set", "port", String(port)], project, cliHome)
    run(binary, ["service", "start"], project, cliHome)
    try {
      const api = (args: readonly string[]) => run(binary, ["api", ...args], project, cliHome)
      const directory = `x-opencode-directory:${project}`
      const readSkills = () => JSON.parse(api(["GET", "/api/skill", "-H", directory])) as { data: { id: string; description: string }[] }
      const readCommands = () => JSON.parse(api(["GET", "/api/command", "-H", directory])) as { data: { name: string }[] }
      // Readiness: the first successful answer, even an empty one, is the service up.
      await waitFor(readSkills, () => true)
      api(["POST", "/api/session", "-d", JSON.stringify({ location: { directory: project }, title: "pack skill probe" }), "-H", directory])
      const repoSkills = readdirSync(join(ROOT, "skills"), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, "skills", entry.name, "SKILL.md")))
        .map((entry) => entry.name)
        .sort()
      expect(repoSkills).toEqual(["colab", "colab-notebooks"])
      // OpenCode activates a location's plugins after its first session, asynchronously; wait for every repo skill.
      const skills = await waitFor(readSkills, (answer) => repoSkills.every((id) => answer.data.some((skill) => skill.id === id)))
      // The project is empty, so those ids can only come from the plugin's own registration. Each served
      // description must equal what a real YAML parser reads from the committed frontmatter, not `>` or `|`.
      for (const id of repoSkills) {
        const text = readFileSync(join(ROOT, "skills", id, "SKILL.md"), "utf8")
        const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1]
        expect(front, id).toBeDefined()
        const parsed = parseYaml(front!) as { name?: unknown; description?: unknown }
        expect(parsed.name, id).toBe(id)
        const description = typeof parsed.description === "string" ? parsed.description.trim() : ""
        expect(description, id).not.toBe("")
        expect(description, id).not.toBe(">")
        expect(description, id).not.toBe("|")
        const served = skills?.data.find((skill) => skill.id === id)
        expect(served?.description, id).toBe(description)
        expect(served?.description.length, id).toBeLessThanOrEqual(300)
      }
      const commands = await waitFor(readCommands, (answer) => answer.data.some((command) => command.name === "colab"))
      const commandNames = commands?.data.map((command) => command.name) ?? []
      for (const name of ["colab", "colab-doctor", "colab-cleanup"]) expect(commandNames).toContain(name)
      expect(commandNames).not.toContain("colab-status")
    } finally {
      try {
        run(binary, ["service", "stop"], project, cliHome)
      } catch {
        // the service may have failed to start; the skill assertion above reports that
      }
    }
  }, 600_000)
})
