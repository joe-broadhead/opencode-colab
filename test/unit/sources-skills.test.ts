// The skills' examples run against the fakes (design §16, package G: "skill examples running against the fakes").
// Every `colab` block in both skills is a sequence of calls, `colab_<tool>({ … })` with strict JSON. Each block runs in
// order through the plugin's own wrapper and registry on Day 0's fakes, in a scratch project holding the notebooks and
// data the examples name, with `<…>` placeholders filled from the previous step's answer.
//
// - Every call is a registered tool, and its input (and a plan's `params`) fits the contract's schema.
// - Every call reaches its handler: none answers INPUT_INVALID, ACCOUNT_UNKNOWN or ACCOUNT_REQUIRED.
// - A call whose tool or plan action belongs to a package already on master (Day 0, C, E, G) neither throws nor
//   answers NOT_IMPLEMENTED; it may answer a refusal of its own (a fake has no job yet, a plan id is not a real one).
//   A call that belongs to D or F (in review on their own branches) may answer anything else of the handler's: their
//   own tests cover what it does, and this test keeps checking the input as they land.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { PLAN_ACTIONS, toolEntry, type Owner } from "../../src/domain/actions.js"
import { CONTRACTS, PLAN_PARAMS, type ToolName } from "../../src/domain/contract.js"
import { SKILL_IDS, parseSkill } from "../../src/skills.js"
import { ourRuntime, sourcesHarness } from "../fakes/sources-harness.js"

const LANDED: ReadonlySet<Owner> = new Set(["Day0", "C", "E", "G"])
const RUNTIME = "oc-01jskillexampleruntime00000"
const OPTIONS = {
  accounts: {
    default: { backend: "colab" },
    work: { backend: "enterprise", project: "invented-project", region: "us-central1", outputBucket: "gs://invented-bucket/runs", serviceAccount: "runner@invented-project.iam.gserviceaccount.com", access: "write" },
  },
}

/** A minimal nbformat 4.5 notebook. */
const notebook = (sources: string[]) =>
  `${JSON.stringify({ cells: sources.map((source, index) => ({ cell_type: "code", id: `c${index}`, metadata: {}, execution_count: null, outputs: [], source })), metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } }, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`

interface Call {
  readonly skill: string
  readonly line: string
  readonly tool: ToolName
  readonly raw: string
}

/** Each skill's `colab` blocks, each a list of calls. */
function blocks(): Call[][] {
  return SKILL_IDS.flatMap((id) => {
    const text = parseSkill(id, readFileSync(new URL(`../../skills/${id}/SKILL.md`, import.meta.url), "utf8")).content
    return [...text.matchAll(/```colab\n([\s\S]*?)```/g)].map((match) =>
      match[1]!
        .split("\n")
        .filter((line) => line.trim() !== "" && !line.trim().startsWith("//"))
        .map((line) => {
          const call = /^colab_([a-z_]+)\((.*)\)$/.exec(line.trim())
          if (!call) throw new Error(`${id}: not a call: ${line}`)
          return { skill: id, line, tool: call[1] as ToolName, raw: call[2]! }
        }),
    )
  })
}

const dirs: string[] = []
afterAll(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("the skills' examples", () => {
  const all = blocks()

  it("are there: the workflow, Enterprise, Drive, sources, and ten worked notebook examples", () => {
    expect(all.length).toBeGreaterThanOrEqual(17)
    expect(all.flat().length).toBeGreaterThanOrEqual(45)
  })

  it("name only registered tools, each with an input that fits its schema", () => {
    for (const call of all.flat()) {
      expect(() => toolEntry(call.tool), call.line).not.toThrow()
      const input = JSON.parse(call.raw.replace(/"<[^">]+>"/g, (token) => (token === '"<hash>"' ? `"sha256:${"0".repeat(64)}"` : token === '"<planId>"' ? '"plan-made-by-colab-plan"' : token === '"<runtime>"' ? `"${RUNTIME}"` : token)))
      const parsed = CONTRACTS[call.tool].input.safeParse(input)
      expect(parsed.success, `${call.line}: ${parsed.success ? "" : parsed.error.message}`).toBe(true)
      if (call.tool === "plan") {
        const action = (input as { action: keyof typeof PLAN_PARAMS }).action
        expect(PLAN_PARAMS[action], call.line).toBeDefined()
        const params = PLAN_PARAMS[action].safeParse((input as { params?: unknown }).params ?? {})
        expect(params.success, `${call.line}: ${params.success ? "" : params.error.message}`).toBe(true)
      }
    }
  })

  it("show colab_plan with the action's own parameters under params, and every commit with only a planId", () => {
    for (const call of all.flat()) {
      const input = JSON.parse(call.raw) as Record<string, unknown>
      if (call.tool === "plan") expect(Object.keys(input).filter((key) => key !== "action" && key !== "account" && key !== "params"), call.line).toEqual([])
      if (call.tool === "write" || call.tool === "delete") expect(Object.keys(input), call.line).toEqual(["planId"])
    }
  })

  it("run against the fakes: each reaches its handler, and the landed packages' calls answer for real", async () => {
    for (const block of all) {
      const directory = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "colab-g-skill-"))
      dirs.push(directory)
      for (const name of ["analysis.ipynb", "report.ipynb", "finetune.ipynb"]) writeFileSync(join(directory, name), notebook(["import pandas as pd", "df = pd.DataFrame({'revenue': [1, 2]})", "df.describe()", "df.head()", "df = df.dropna()", "df.to_csv('/content/outputs/out.csv')"]))
      mkdirSync(join(directory, "data"), { recursive: true })
      writeFileSync(join(directory, "data", "sales.csv"), "region,revenue\nnorth,12\nsouth,7\n")
      const h = sourcesHarness({ options: OPTIONS, directory })
      h.fakes.auth.grants.set("default", ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"])
      h.fakes.auth.emails.set("default", "ada@example.invalid")
      h.fakes.auth.grants.set("work", ["https://www.googleapis.com/auth/cloud-platform"])
      await ourRuntime(h.ledger, RUNTIME, "default")
      h.fakes.colab.runtimes.set(RUNTIME, { name: `runtimes/${RUNTIME}`, spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" } })
      const last: Record<string, string> = { runtime: RUNTIME, planId: "plan-not-made-in-this-block", runId: "run-from-the-skill-example", job: "skill-example-job", schedule: "projects/invented-project/locations/us-central1/schedules/1", "drive file id": "drive-file-from-the-example", hash: `sha256:${"0".repeat(64)}`, cursor: "" }
      let planOwner: Owner = "Day0"
      for (const call of block) {
        const raw = call.raw.replace(/"<([^">]+)>"/g, (_token, name: string) => {
          if (!(name in last)) throw new Error(`${call.line}: no value for <${name}>`)
          return JSON.stringify(last[name])
        })
        const input = JSON.parse(raw) as Record<string, unknown>
        const account = String(input.account ?? "default")
        const backend = account === "work" ? "enterprise" : "colab"
        let owner: Owner = toolEntry(call.tool).owner
        if (call.tool === "plan") {
          const entry = PLAN_ACTIONS[input.action as keyof typeof PLAN_ACTIONS].backends as Partial<Record<string, { owner: Owner }>>
          owner = entry[backend]!.owner
          planOwner = owner
        }
        if (call.tool === "write" || call.tool === "delete") owner = planOwner
        let outcome: unknown
        let thrown: string | undefined
        try {
          outcome = await h.tool(call.tool, input)
        } catch (error) {
          thrown = (error as Error).message
        }
        const answer = (outcome ?? {}) as Record<string, unknown>
        expect(["INPUT_INVALID", "ACCOUNT_UNKNOWN", "ACCOUNT_REQUIRED"], `${call.line}: ${String(answer.message ?? thrown)}`).not.toContain(answer.error)
        if (LANDED.has(owner)) {
          expect(thrown, call.line).toBeUndefined()
          expect(answer.error, `${call.line}: ${String(answer.message)}`).not.toBe("NOT_IMPLEMENTED")
        }
        if (typeof answer.hash === "string") last.hash = answer.hash
        if (typeof answer.planId === "string" && call.tool === "plan") last.planId = answer.planId
        if (typeof answer.runId === "string") last.runId = answer.runId
        if (typeof answer.cursor === "string") last.cursor = answer.cursor
        const result = answer.result as Record<string, unknown> | undefined
        if (typeof result?.job === "string") last.job = result.job
        if (typeof result?.schedule === "string") last.schedule = result.schedule
      }
    }
  }, 60_000)
})
