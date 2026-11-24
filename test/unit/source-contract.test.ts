// The source contract the plugin bundles: one commit, named the same in package.json, the lockfile, NOTICE and the
// docs, and the tools RPC entry points the plugin imports still exported by it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as toolsRpc from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "../../src/constants.js"
import { TOOLS_RPC_ID } from "../../src/tools-rpc.js"

const root = fileURLToPath(new URL("../..", import.meta.url))
const read = (path: string) => readFileSync(join(root, path), "utf8")
const NAME = "@we-the-rebel-alliance/source-contract"
// The v0.3.0 commit: the release tag was deleted with the repository rename, so the dependency pins the commit.
const COMMIT = "2fd55cdc0c6c1067927fefc403a88bfd18c9a971"
const VERSION = "0.3.0"

describe("the source contract", () => {
  it(`is pinned to ${COMMIT.slice(0, 7)} everywhere it is named`, () => {
    const pkg = JSON.parse(read("package.json")) as { devDependencies: Record<string, string> }
    expect(pkg.devDependencies[NAME]).toBe(`github:we-the-rebel-alliance/source-contract#${COMMIT}`)
    const lock = JSON.parse(read("package-lock.json")) as { packages: Record<string, { version?: string; resolved?: string; devDependencies?: Record<string, string> }> }
    expect(lock.packages[""]?.devDependencies?.[NAME]).toBe(`github:we-the-rebel-alliance/source-contract#${COMMIT}`)
    expect(lock.packages[`node_modules/${NAME}`]?.version).toBe(VERSION)
    expect(lock.packages[`node_modules/${NAME}`]?.resolved).toContain(`#${COMMIT}`)
    expect(read("NOTICE")).toContain(`## ${NAME} ${VERSION} (MIT)`)
    expect(read("docs/scripting.md")).toContain(COMMIT)
    expect(read("src/tools-rpc.ts")).toContain(COMMIT)
  })

  it("still exports the tools RPC entry points the plugin imports", () => {
    expect(typeof toolsRpc.registerToolsRpc).toBe("function")
    expect(typeof toolsRpc.toolsRpcId).toBe("function")
    expect(TOOLS_RPC_ID).toBe(`${PLUGIN_ID}.tools`)
  })
})
