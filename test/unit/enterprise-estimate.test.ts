/**
 * The ledger's Enterprise estimate (contract request 1, colab-10 M4): `openJobCreate` stores the figure the
 * `job.create` preview computed and its commit re-checked, and every later write keeps it. That is what makes the
 * daily budget complete, so a `refuse` budget stops a third $5 job against a $10 limit, and `BUDGET_REACHED` still
 * names the limit in dollars.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/deps.js"
import { budgetCheck } from "../../src/enterprise/common.js"
import { abandonJobCreate, confirmJobCreate, createEnterpriseRuns, openJobCreate, type EnterpriseRunsEnv } from "../../src/enterprise/runs.js"
import type { HandlerContext } from "../../src/tools/types.js"
import { FakeClock, fakeDeps } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const OPTIONS = { accounts: { work: { backend: "enterprise" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-estimate-"))
  temporary.push(directory)
  const { deps: base, fakes } = fakeDeps({ options: OPTIONS, directory })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  const env: EnterpriseRunsEnv = { ...deps, vertex, gcs, fetch: globalThis.fetch }
  return { deps, fakes, vertex, gcs, runs: createEnterpriseRuns(env, { pollMs: 0, cancelWaitMs: 0 }) }
}

const jobName = (id: string) => `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`

describe("the Enterprise estimate in the ledger", () => {
  it("is written by openJobCreate and kept by confirmJobCreate and abandonJobCreate", async () => {
    const { fakes } = setup()
    const clock: FakeClock = fakes.clock
    await openJobCreate({ ledger: fakes.ledger, clock }, "work", "oc-job-a", { summary: "Colab Enterprise job oc-job-a", estimatedUsd: 5 })
    expect(await fakes.ledger.getRun("oc-job-a")).toMatchObject({ estimatedUsd: 5, state: "running" })

    await confirmJobCreate({ ledger: fakes.ledger, clock }, "work", { name: jobName("oc-job-a"), displayName: "a", state: "JOB_STATE_SUCCEEDED", endTime: "2026-11-17T10:00:00.000Z" }, "operations/1")
    expect(await fakes.ledger.getRun("oc-job-a")).toMatchObject({ estimatedUsd: 5, state: "ok", operation: "operations/1" })

    await openJobCreate({ ledger: fakes.ledger, clock }, "work", "oc-job-b", { summary: "Colab Enterprise job oc-job-b", estimatedUsd: 5 })
    await abandonJobCreate({ ledger: fakes.ledger, clock }, "work", "oc-job-b", "UNAVAILABLE")
    expect(await fakes.ledger.getRun("oc-job-b")).toMatchObject({ estimatedUsd: 5, state: "failed" })
  })

  it("survives the record a finished job's read writes, so the day's sum does not lose it", async () => {
    const { fakes, vertex, runs } = setup()
    await openJobCreate({ ledger: fakes.ledger, clock: fakes.clock }, "work", "oc-job-c", { summary: "Colab Enterprise job oc-job-c", estimatedUsd: 5 })
    // A cancelled job writes no output notebook: the read takes the cancellation branch and records the end.
    vertex.jobs.set(jobName("oc-job-c"), { name: jobName("oc-job-c"), displayName: "c", state: "JOB_STATE_CANCELLED", createTime: "2026-11-17T09:00:00.000Z", endTime: "2026-11-17T10:00:00.000Z", gcsOutputUri: "gs://results/oc-job-c/" })
    const answer = await runs.execution("work", { job: "oc-job-c" }, new AbortController().signal, async () => undefined)
    expect(answer).toMatchObject({ state: "cancelled" })
    expect(await fakes.ledger.getRun("oc-job-c")).toMatchObject({ estimatedUsd: 5, state: "cancelled" })
  })

  it("answers BUDGET_REACHED with the limit in dollars, from the new unit/limit fields", async () => {
    const refused = { deps: { budget: { check: async () => ({ verdict: "refuse", spent: 10, limit: 10, unit: "usd" }) } }, account: { alias: "work" }, call: { signal: new AbortController().signal } } as unknown as HandlerContext
    await expect(budgetCheck(refused, "job.create", 5)).rejects.toThrow("The account's budget refuses job.create (limit $10.00).")

    // A runtime-hours answer names no dollar figure.
    const hours = { deps: { budget: { check: async () => ({ verdict: "refuse", spent: 4, limit: 4, unit: "runtime-hours" }) } }, account: { alias: "work" }, call: { signal: new AbortController().signal } } as unknown as HandlerContext
    await expect(budgetCheck(hours, "job.create", 5)).rejects.toThrow("The account's budget refuses job.create.")
    const warn = { deps: { budget: { check: async () => ({ verdict: "warn" }) } }, account: { alias: "work" }, call: { signal: new AbortController().signal } } as unknown as HandlerContext
    expect(await budgetCheck(warn, "job.create", 5)).toEqual(["BUDGET_WARN"])
  })
})
