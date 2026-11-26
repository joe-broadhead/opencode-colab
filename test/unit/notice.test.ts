// The NOTICE must carry the licence of every package that `npm run bundle` actually inlines. The build uses the same
// options as scripts/build.mjs; a package that appears in the bundle without its verbatim licence fails this test.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const EXTERNAL = ["@opencode/plugin", "@opencode/plugin/*", "@opencode/sdk", "@opencode/client", "@opencode/client/*"]
const PLUGIN = "@we-the-rebel-alliance/colab-plugin"

interface BundledPackage {
  name: string
  version: string
  licence: string
  text: string
}

function packageOf(path: string): string | undefined {
  return /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(path)?.[1]
}

async function bundledPackages(): Promise<BundledPackage[]> {
  const result = await build({
    absWorkingDir: ROOT,
    entryPoints: ["src/index.ts"],
    bundle: true,
    splitting: false,
    minify: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    target: "es2022",
    external: EXTERNAL,
    legalComments: "inline",
    banner: { js: `import { createRequire } from "node:module";\nconst require = createRequire(import.meta.url);` },
    logLevel: "silent",
  })
  const names = new Set<string>()
  for (const path of Object.keys(result.metafile!.inputs)) {
    const name = packageOf(path)
    if (name !== undefined && name !== PLUGIN && !name.startsWith("@opencode/")) names.add(name)
  }
  return [...names].sort().map((name) => {
    const meta = JSON.parse(readFileSync(join(ROOT, "node_modules", name, "package.json"), "utf8")) as {
      version: string
      license: string
    }
    return {
      name,
      version: meta.version,
      licence: meta.license,
      text: readFileSync(join(ROOT, "node_modules", name, "LICENSE"), "utf8"),
    }
  })
}

function section(notice: string, heading: string): string | undefined {
  const marker = `## ${heading}\n`
  const start = notice.indexOf(marker)
  if (start < 0) return undefined
  const body = notice.slice(start + marker.length)
  const end = body.indexOf("\n## ")
  return end < 0 ? body : body.slice(0, end)
}

function noticeProblems(notice: string, packages: readonly BundledPackage[]): string[] {
  const problems: string[] = []
  for (const pkg of packages) {
    const heading = `${pkg.name} ${pkg.version} (${pkg.licence})`
    const body = section(notice, heading)
    if (body === undefined) {
      problems.push(`${pkg.name}: missing "## ${heading}"`)
      continue
    }
    const text = body.replace(/^\n+/, "").replace(/\n+$/, "\n")
    if (text !== pkg.text) problems.push(`${pkg.name}: licence text is not verbatim`)
  }
  return problems
}

describe("NOTICE", () => {
  it("carries every bundled package's verbatim licence", async () => {
    const packages = await bundledPackages()
    expect(packages.map((pkg) => pkg.name)).toEqual(["@we-the-rebel-alliance/plugin-contract", "yaml", "zod"])
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8")
    expect(noticeProblems(notice, packages)).toEqual([])
  }, 30_000)

  it("reports a missing section and altered licence text", async () => {
    const packages = await bundledPackages()
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8")
    const withoutYaml = notice.replace(/^## yaml[\s\S]*?(?=^## |\s*$)/m, "")
    expect(noticeProblems(withoutYaml, packages)).toContain('yaml: missing "## yaml 2.9.1 (ISC)"')
    const altered = notice.replace("Copyright (c) 2025 Colin McDonnell", "Copyright (c) 2024 Colin McDonnell")
    expect(noticeProblems(altered, packages)).toContain("zod: licence text is not verbatim")
  }, 30_000)
})
