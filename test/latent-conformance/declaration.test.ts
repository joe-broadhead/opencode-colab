import { expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertDeclaration } from "@we-the-rebel-alliance/source-contract/conformance"
import { readInstalledDescriptor } from "@we-the-rebel-alliance/source-contract/descriptor"
import { TOOLS } from "../../src/domain/actions.js"
import { METHOD_NAMES, TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { latentSources, PACKAGE_NAME, PACKAGE_VERSION } from "../fakes/sources-descriptor.js"

test("the latent fixture declares the right sources and a consumer can read it", async () => {
  const sources = latentSources()
  const tools = METHOD_NAMES.map((id) => ({ id, readOnly: id === "probe" || TOOLS.find((tool) => tool.name === id)?.class === "read" }))
  expect(() => assertDeclaration(sources, { tools })).not.toThrow()
  expect(sources).toMatchObject({
    rpc: TOOLS_RPC_ID, probe: { action: "colab.probe" },
    items: [{ id: "colab.runs", tool: "events_list" }, { id: "colab.runtimes", tool: "runtimes_read" }],
  })
  const dir = await mkdtemp(join(tmpdir(), "colab-latent-declaration-"))
  try {
    await writeFile(join(dir, "package.json"), JSON.stringify({ name: PACKAGE_NAME, version: PACKAGE_VERSION, sources }))
    expect(readInstalledDescriptor(dir).ok).toBe(true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
