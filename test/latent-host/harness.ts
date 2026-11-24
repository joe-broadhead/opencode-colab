// Build a separate synthetic full-plugin fixture; never overwrite or pack dist/ from the editing package.
import { ROOT } from "../host/isolate.js"
import { cp, mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { simulateTaggedRelease } from "../../src/release.js"
import { startHost as start, type HostInput } from "../host/harness.js"

export { agentRules, cleanup, pluginState, status, until, type Host } from "../host/harness.js"

const repo = fileURLToPath(new URL("../..", import.meta.url))
const fixture = join(ROOT, "latent-plugin")
let ready: Promise<void> | undefined

async function prepare() {
  await mkdir(fixture)
  await cp(join(repo, "skills"), join(fixture, "skills"), { recursive: true })
  await symlink(join(repo, "node_modules"), join(fixture, "node_modules"), "dir")
  await writeFile(join(fixture, "package.json"), JSON.stringify({ name: "colab-latent-test-fixture", version: "0.0.0", type: "module", exports: "./dist/index.js" }))
  await build({
    absWorkingDir: repo,
    stdin: { contents: 'import { createColabPlugin } from "./src/plugin.js"; export default createColabPlugin()', resolveDir: repo },
    outfile: join(fixture, "dist", "index.js"),
    bundle: true, format: "esm", platform: "node", external: ["@opencode/plugin", "@opencode/plugin/*"],
    define: { __PLUGIN_VERSION__: '"0.0.0"' },
  })
}

export async function startHost(input: HostInput = {}) {
  await (ready ??= prepare())
  simulateTaggedRelease(true)
  return start({ ...input, fixture })
}
