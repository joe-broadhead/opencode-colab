// The NOTICE must name every package that `npm run bundle` actually redistributes. The build uses the same externals as
// scripts/build.mjs; a package that appears in the bundle without a NOTICE section fails this test.
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { describe, expect, it } from "vitest"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const EXTERNAL = ["@opencode/plugin", "@opencode/plugin/*", "@opencode/sdk", "@opencode/client", "@opencode/client/*"]

describe("NOTICE", () => {
  it("names every package the bundle actually redistributes", async () => {
    const result = await build({
      absWorkingDir: ROOT,
      entryPoints: ["src/index.ts"],
      bundle: true,
      write: false,
      metafile: true,
      platform: "node",
      format: "esm",
      target: "es2022",
      external: EXTERNAL,
      logLevel: "silent",
    })
    const bundled = new Set<string>()
    for (const input of Object.keys(result.metafile!.inputs)) {
      const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input)
      if (match === null) continue
      const name = match[1]!
      if (name.startsWith("@opencode/")) continue
      bundled.add(name)
    }
    expect([...bundled].sort()).toEqual(["@we-the-rebel-alliance/plugin-contract", "yaml", "zod"])
    const notice = readFileSync(new URL("../../NOTICE", import.meta.url), "utf8")
    for (const pkg of bundled) expect(notice, pkg).toContain(`## ${pkg} `)
  }, 30_000)
})
