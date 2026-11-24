// Run every shipped skill example against a synthetic local notebook, with no host or provider.
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { contracts, type EditingTool } from "../../src/editing/contract.js"
import { loadEditingOptions } from "../../src/editing/options.js"
import { runEditingTool } from "../../src/editing/tools.js"
import { notebookHash } from "../../src/notebooks/model.js"
import { SKILL_IDS, parseSkill } from "../../src/skills.js"

it("validates and executes all local skill examples", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "colab-skills-")))
  try {
    const runner = { directory, options: loadEditingOptions({}), assert: async () => undefined, verify: async () => undefined }
    const call = { sessionID: "ses_fixture", agent: "build", messageID: "msg_fixture", id: "call_fixture", signal: new AbortController().signal }
    const seen: string[] = []
    for (const id of SKILL_IDS) {
      const raw = await readFile(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")
      const skill = parseSkill(id, raw)
      for (const block of skill.content.matchAll(/```colab\n([\s\S]*?)```/g)) {
        for (const line of block[1]!.trim().split("\n")) {
          const match = /^colab_(find|edit|notebook)\((.*)\)$/.exec(line)
          expect(match, line).not.toBeNull()
          const name = match![1] as EditingTool
          const args = JSON.parse(match![2]!)
          expect(contracts[name].input.safeParse(args).success, line).toBe(true)
          const output = await runEditingTool(name, args, call, runner)
          expect(contracts[name].output.safeParse(output).success, line).toBe(true)
          if (name === "edit" && process.platform !== "linux") {
            expect(output).toMatchObject({ error: "EDIT_UNAVAILABLE" })
            await writeFile(join(directory, "example.ipynb"), JSON.stringify({
              nbformat: 4, nbformat_minor: 5, metadata: {},
              cells: [{ id: "example", cell_type: "markdown", metadata: {}, source: ["# Example"] }],
            }))
          } else expect(output, line).toMatchObject({ state: "ok" })
          if (name === "notebook") expect(output).toMatchObject({ hash: notebookHash(await readFile(join(directory, "example.ipynb"))), cells: [{ source: "# Example" }] })
          seen.push(name)
        }
      }
    }
    expect(seen).toEqual(["find", "edit", "notebook"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
