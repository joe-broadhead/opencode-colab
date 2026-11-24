import { mkdtemp, readdir, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import { loadEditingOptions } from "../../src/editing/options.js"
import { runEditingTool } from "../../src/editing/tools.js"

// Assert the publication contract at the filesystem boundary; no race or other process is needed.
const link = vi.hoisted(() => vi.fn(async () => {
  throw Object.assign(new Error("fixture: destination exists"), { code: "EEXIST" })
}))
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), link }))

it("treats a kernel no-clobber refusal as final and removes private scratch bytes", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "colab-write-")))
  try {
    const call = { sessionID: "ses_fixture", agent: "build", messageID: "msg_fixture", id: "call_fixture", signal: new AbortController().signal }
    const runner = { directory, options: loadEditingOptions({}), assert: async () => undefined, verify: async () => undefined }
    const output = await runEditingTool("edit", { path: "example.ipynb", ops: [{ op: "create" }] }, call, runner)
    if (process.platform === "linux") {
      expect(link).toHaveBeenCalledTimes(1)
      expect(output).toMatchObject({ state: "refused", error: "FILE_EXISTS" })
    } else {
      expect(link).not.toHaveBeenCalled()
      expect(output).toMatchObject({ state: "refused", error: "EDIT_UNAVAILABLE" })
    }
    expect(await readdir(directory)).toEqual([])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
