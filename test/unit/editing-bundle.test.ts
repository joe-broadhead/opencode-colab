import { fileURLToPath } from "node:url"
import { build } from "esbuild"
import { expect, it } from "vitest"

const root = fileURLToPath(new URL("../..", import.meta.url))

it("the server graph is a positive allowlist of editing mechanics and host surfaces, with no provider code", async () => {
  const built = await build({
    absWorkingDir: root, entryPoints: ["src/index.ts"], bundle: true, write: false, metafile: true,
    platform: "node", format: "esm", external: ["@opencode/plugin", "@opencode/plugin/*"],
    define: { __PLUGIN_VERSION__: '"0.0.0-fixture"' },
  })
  const src = Object.keys(built.metafile!.inputs).filter((path) => path.startsWith("src/")).sort()
  expect(src).toEqual([
    "src/constants.ts", "src/domain/errors.ts", "src/domain/notebook-contract.ts",
    "src/editing/contract.ts", "src/editing/file-permissions.ts", "src/editing/files.ts", "src/editing/options.ts", "src/editing/plugin.ts", "src/editing/tools.ts", "src/editing/write.ts",
    "src/host-version.ts", "src/index.ts", "src/notebooks/edit-model.ts", "src/notebooks/lock.ts", "src/notebooks/model.ts",
    "src/notebooks/paths.ts", "src/notebooks/view.ts", "src/permission-defaults.ts",
    "src/redact.ts", "src/rpc.ts", "src/skills.ts", "src/status-surface.ts", "src/version.ts",
  ].sort())
  const external = Object.values(built.metafile!.outputs).flatMap(({ imports }) => imports.filter((entry) => entry.external).map(({ path }) => path))
  expect(external.filter((path) => !/^(node:|@opencode\/plugin(?:\/|$))/.test(path))).toEqual([])
  expect(built.outputFiles[0]!.text).not.toMatch(/node:child_process|(?:colab|aiplatform|oauth2|storage)\.googleapis\.com|www\.googleapis\.com\/drive/)
})
