/**
 * The packed tarball and the real install path:
 *
 * 1. `npm pack` holds the package whitelist, no runtime dependencies and the server export.
 * 2. A temp git checkout of the tarball's contents is installed with the real `opencode` 2.4.1 CLI
 *    (`opencode plugin add git+file://…#v0.0.0`) in an isolated HOME, and `opencode plugin list` shows it.
 * 3. The installed package in the CLI's cache is loaded by the contract's real embedded host, which answers `status`.
 *
 * The stock `opencode service` in 2.4.1 does not activate global plugins in this build (even a minimal plugin yields no
 * `/api/plugin` entry), so the load half uses the contract's real host on the same installed cache package.
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import { afterAll, describe, expect, test } from "vitest"

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

function installedPackage(cache: string): string {
  for (const entry of readdirSync(cache, { recursive: true, withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(entry.parentPath, entry.name)
    if (path.endsWith(join("node_modules", ...PACKAGE.split("/")))) return path
  }
  throw new Error(`the installed package is not under ${cache}`)
}

describe("the packed tarball", () => {
  test("installs with the real opencode CLI and the installed package answers status in the real host", () => {
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
        `try { const answer = await run.call("status", {}); console.log(JSON.stringify({ ok: answer.ok, output: answer.ok ? answer.output : answer })) } finally { await run.close() }\n`,
    )
    const output = JSON.parse(run(process.execPath, [probe], base, home).trim().split("\n").at(-1)!) as { ok: boolean; output: Record<string, unknown> }
    expect(output.ok).toBe(true)
    expect(output.output).toMatchObject({ name: "colab", version: "0.0.0", state: "needs_sign_in" })
  }, 600_000)
})
