// Build dist/index.js: one self-contained ESM bundle. The host provides @opencode/plugin and its subpaths; everything
// else (zod, the contract's runtime modules) is inlined, so an in-place update never mixes entries.
import { rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { build } from "esbuild"

const root = fileURLToPath(new URL("../", import.meta.url))
const external = ["@opencode/plugin", "@opencode/plugin/*", "@opencode/sdk", "@opencode/client", "@opencode/client/*"]

rmSync(join(root, "dist"), { recursive: true, force: true })
await build({
  absWorkingDir: root,
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(root, "dist/index.js"),
  bundle: true,
  splitting: false,
  minify: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  external,
  legalComments: "inline",
  logLevel: "warning",
})
