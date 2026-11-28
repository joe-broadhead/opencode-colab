/**
 * The Enterprise branches of package D's tools, behind `EnterpriseRuns` (design §6, §9.4): `colab_execution({ job })`
 * polls a job and captures its output notebook from GCS, `colab_cancel({ job })` goes through the create LRO's
 * `operations.cancel`, and `colab_download({ gcs })` writes an object into the workspace.
 *
 * These prove the plugin's side only: the request shape, the per-job output folder, the capture path, the LRO cancel and
 * its bad answer, and that the read keeps no local history. The live checks they prepare for — L10, L11 and L13 — remain
 * unrun, and this file does not stand in for them.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/provider/index.js"
import { CONTRACTS } from "../../src/domain/contract.js"
import { createEnterpriseRuns, type EnterpriseRunsEnv } from "../../src/provider/enterprise/runs.js"
import { runTool, type Runner } from "../support/methods.js"
import { fakeDeps } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_execution", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const OPTIONS = { accounts: { work: { backend: "enterprise" as const, mode: "adc" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

const directories: string[] = []
/** Every provider read E asked D's tool to assert, in order. */
const reads: string[] = []
const read = async (operation: string) => {
  reads.push(operation)
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
  reads.splice(0)
})

function workspace(): string {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-execution-"))
  directories.push(directory)
  return directory
}

const outputNotebook = (label: string) => ({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" } },
  cells: [
    {
      cell_type: "code",
      id: "c1",
      execution_count: 1,
      metadata: {},
      source: [`print("${label}")`],
      outputs: [
        { output_type: "stream", name: "stdout", text: [`${label}\n`] },
        { output_type: "execute_result", execution_count: 1, metadata: {}, data: { "text/plain": ["42"] } },
      ],
    },
    { cell_type: "code", id: "c2", execution_count: 2, metadata: {}, source: [], outputs: [{ output_type: "display_data", metadata: {}, data: { "image/png": PNG, "text/plain": ["<Figure>"] } }] },
    { cell_type: "code", id: "c3", execution_count: 3, metadata: {}, source: [], outputs: [{ output_type: "error", ename: "ValueError", evalue: "boom", traceback: ["Traceback", "ValueError: boom"] }] },
  ],
})

function setup() {
  const directory = workspace()
  const { deps: base, fakes } = fakeDeps({ options: OPTIONS, directory })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  let runner: Runner
  runner = { deps }
  const env: EnterpriseRunsEnv = { ...deps, vertex, gcs, fetch: globalThis.fetch }
  const runs = createEnterpriseRuns(env, { pollMs: 0, cancelWaitMs: 0 })
  return { deps, fakes, vertex, gcs, runner, runs, directory }
}

async function createJob(input: { directory: string; runner: Runner }): Promise<string> {
  const path = join(input.directory, "job.ipynb")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: ["print(1)"] }] }))
  const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), input.runner)) as { plan: unknown }
  const committed = (await runTool("write", { plan: planned.plan }, call(), input.runner)) as { result: { id: string } }
  return committed.result.id
}

describe("colab_execution on an Enterprise job", () => {
  it("answers running with a next step while the job runs", async () => {
    const { runner, runs, directory } = setup()
    const id = await createJob({ directory, runner })
    const running = (await runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)) as Record<string, unknown>
    expect(running).toMatchObject({ state: "running", runId: id, cells: [], files: [] })
    expect(running.next).toContain(`colab_execution({ job: "${id}"`)
  })

  it("captures the output notebook into .colab/runs/<id>, with cells, a rich file and outputs.jsonl", async () => {
    const { runner, runs, vertex, gcs, directory, fakes } = setup()
    const id = await createJob({ directory, runner })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    vertex.setJobState(name, "JOB_STATE_SUCCEEDED")
    gcs.putNotebook(`gs://results/${id}/output.ipynb`, outputNotebook("new"), "2026-11-17T09:10:00Z")
    const result = (await runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(result).toMatchObject({ state: "ok", runId: id, job: name, trust: "untrusted" })
    expect(result.cells).toHaveLength(3)
    expect(result.cells[0]).toMatchObject({ id: "c1", state: "ok", executionCount: 1, stdout: "new\n", result: "42" })
    expect(result.cells[1].rich[0]).toMatchObject({ mime: "image/png" })
    expect(result.cells[2].state).toBe("error")
    expect(result.cells[2].error).toMatchObject({ ename: "ValueError", evalue: "boom" })
    expect(result.files).toContain(`.colab/runs/${id}/output.ipynb`)
    expect(result.files).toContain(`.colab/runs/${id}/outputs.jsonl`)
    expect(existsSync(join(directory, `.colab/runs/${id}/output.ipynb`))).toBe(true)
    expect(existsSync(join(directory, result.cells[1].rich[0].path))).toBe(true)
    const lines = readFileSync(join(directory, `.colab/runs/${id}/outputs.jsonl`), "utf8").trim().split("\n")
    expect(lines).toHaveLength(4)
    // Polling keeps the create operation the ledger recorded, so cancel-after-restart still works.
    expect((await fakes.ledger.getRun(id))?.operation).toBe(vertex.operationNames[0])
    // The ledger closes the run, and the colab.runs source sees one finished event.
    expect(reads).toContain("aiplatform.projects.locations.notebookExecutionJobs.get")
    expect(reads).toContain("storage.objects.list")
    expect(reads).toContain("storage.objects.get")
    expect(await fakes.ledger.getRun(id)).toMatchObject({ state: "ok", backend: "enterprise", endedAt: expect.any(String) })
    expect(fakes.ledger.events.filter((event) => event.id === id && event.type === "run.finished")).toHaveLength(1)
    // A second poll reads back what the first wrote.
    const again = (await runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(again.cells).toHaveLength(3)
  })

  it("picks the newest output notebook written at or after the job's create time", async () => {
    const { runner, runs, vertex, gcs, directory } = setup()
    const id = await createJob({ directory, runner })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    vertex.setJobState(name, "JOB_STATE_SUCCEEDED")
    gcs.putNotebook(`gs://results/old.ipynb`, outputNotebook("old"), "2026-11-17T08:00:00Z")
    gcs.putNotebook(`gs://results/${id}/output.ipynb`, outputNotebook("new"), "2026-11-17T09:10:00Z")
    const result = (await runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(result.cells[0].stdout).toBe("new\n")
  })

  it("answers JOB_FAILED with no notebook, and JOB_TIMEOUT once the timeout is spent", async () => {
    const { runner, runs, vertex, fakes, directory } = setup()
    const id = await createJob({ directory, runner })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    vertex.setJobState(name, "JOB_STATE_FAILED")
    await expect(runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)).rejects.toMatchObject({ code: "JOB_FAILED" })
    fakes.clock.advance(2 * 3_600_000)
    await expect(runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)).rejects.toMatchObject({ code: "JOB_TIMEOUT" })
  })

  it("returns a cancelled job as cancelled, with its notebook when there is one", async () => {
    const { runner, runs, vertex, gcs, directory } = setup()
    const id = await createJob({ directory, runner })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    vertex.setJobState(name, "JOB_STATE_CANCELLED")
    gcs.putNotebook(`gs://results/${id}/output.ipynb`, outputNotebook("cancelled"), "2026-11-17T09:05:00Z")
    const result = (await runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(result).toMatchObject({ state: "cancelled", runId: id, trust: "untrusted" })
    expect(result.cells).toHaveLength(3)
  })

  it("answers NOT_FOUND for a job that does not exist", async () => {
    const { runs } = setup()
    await expect(runs.execution("work", { job: "oc-job-missing", wait: 0 }, new AbortController().signal, read)).rejects.toMatchObject({ code: "NOT_FOUND" })
  })
})

describe("colab_cancel on an Enterprise job", () => {
  it("cancels through the create LRO and reports the job cancelled", async () => {
    const { runner, runs, vertex, directory } = setup()
    const id = await createJob({ directory, runner })
    expect(vertex.operationNames).toHaveLength(1)
    const result = (await runs.cancel("work", id, new AbortController().signal, read)) as Record<string, unknown>
    expect(result).toMatchObject({ state: "ok", job: id, action: "cancelled", remainingSec: 0 })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    expect(vertex.calls.filter((entry) => entry.method === "cancelOperation").map((entry) => entry.args[1])).toEqual([vertex.operationNames[0]])
    expect(vertex.jobs.get(name)!.state).toBe("JOB_STATE_CANCELLED")
  })

  it("answers cancel-requested when the cancel was sent but the job had not stopped (L11)", async () => {
    const { runner, runs, vertex, directory } = setup()
    const id = await createJob({ directory, runner })
    vertex.cancelStops = false
    const result = (await runs.cancel("work", id, new AbortController().signal, read)) as Record<string, unknown>
    expect(result).toMatchObject({ state: "ok", job: id, action: "cancel-requested", message: expect.stringContaining("still JOB_STATE_RUNNING") })
    expect(result.remainingSec).toBeGreaterThan(0)
    expect(CONTRACTS.cancel.output.safeParse(result).success).toBe(true)
  })

  it("answers JOB_UNCANCELLABLE for a job this process did not create, with what remains", async () => {
    const { runs, vertex } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/scheduled-1"
    vertex.putJob({ name, displayName: "from a schedule", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z", executionTimeoutSeconds: 3600 })
    await expect(runs.cancel("work", name, new AbortController().signal, read)).rejects.toMatchObject({ code: "JOB_UNCANCELLABLE", next: expect.stringContaining("3600 s left") })
  })
})

describe("colab_download with a gcs source", () => {
  it("writes the object under .colab/files, hints charts for a CSV, and never overwrites without asking", async () => {
    const { runs, gcs, directory } = setup()
    const csv = new Uint8Array(Buffer.from("a,b\n1,2\n"))
    gcs.put("gs://results/data.csv", csv)
    const downloaded = (await runs.downloadGcs("work", { gcs: "gs://results/data.csv" }, new AbortController().signal, read)) as Record<string, unknown>
    expect(downloaded).toMatchObject({ state: "ok", path: ".colab/files/data.csv", bytes: csv.length, charts: expect.stringContaining("charts_quick") })
    expect(readFileSync(join(directory, ".colab/files/data.csv"))).toEqual(Buffer.from(csv))
    await expect(runs.downloadGcs("work", { gcs: "gs://results/data.csv" }, new AbortController().signal, read)).rejects.toMatchObject({ code: "FILE_EXISTS" })
    await expect(runs.downloadGcs("work", { gcs: "gs://results/data.csv", to: "../outside.csv" }, new AbortController().signal, read)).rejects.toMatchObject({ code: "PATH_REFUSED" })
    const overwritten = (await runs.downloadGcs("work", { gcs: "gs://results/data.csv", overwrite: true }, new AbortController().signal, read)) as Record<string, unknown>
    expect(overwritten.state).toBe("ok")
  })
})

describe("each job reads only its own output folder (review M2)", () => {
  it("P2: job A's execution returns A's notebook when B wrote later in the same bucket", async () => {
    const { runner, runs, vertex, gcs, directory } = setup()
    const a = await createJob({ directory, runner })
    const b = await createJob({ directory, runner })
    const name = (id: string) => `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    vertex.setJobState(name(a), "JOB_STATE_SUCCEEDED")
    vertex.setJobState(name(b), "JOB_STATE_SUCCEEDED")
    gcs.putNotebook(`gs://results/${a}/output.ipynb`, outputNotebook("from A"), "2026-11-17T09:10:00Z")
    gcs.putNotebook(`gs://results/${b}/output.ipynb`, outputNotebook("from B"), "2026-11-17T09:20:00Z")
    const result = (await runs.execution("work", { job: a, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(result.cells[0].stdout).toBe("from A\n")
  })

  it("refuses an ambiguous folder rather than taking the newest notebook", async () => {
    const { runner, runs, vertex, gcs, directory } = setup()
    const id = await createJob({ directory, runner })
    vertex.setJobState(`projects/proj/locations/us-central1/notebookExecutionJobs/${id}`, "JOB_STATE_SUCCEEDED")
    gcs.putNotebook(`gs://results/${id}/one.ipynb`, outputNotebook("one"), "2026-11-17T09:10:00Z")
    gcs.putNotebook(`gs://results/${id}/two.ipynb`, outputNotebook("two"), "2026-11-17T09:20:00Z")
    await expect(runs.execution("work", { job: id, wait: 0 }, new AbortController().signal, read)).rejects.toMatchObject({
      code: "RESULTS_UNAVAILABLE",
      message: expect.stringContaining("2 notebooks"),
    })
  })

  it("reads a job the plugin did not create only under its own per-job folder", async () => {
    const { runs, vertex, gcs } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/scheduled-9"
    vertex.putJob({ name, displayName: "scheduled", state: "JOB_STATE_SUCCEEDED", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:30:00Z", gcsOutputUri: "gs://results/oc-schedule-token/", executionTimeoutSeconds: 3600 })
    // A notebook directly in the schedule's folder is not this job's: no guess.
    gcs.putNotebook("gs://results/oc-schedule-token/run.ipynb", outputNotebook("schedule folder"), "2026-11-17T09:10:00Z")
    await expect(runs.execution("work", { job: name, wait: 0 }, new AbortController().signal, read)).rejects.toMatchObject({ code: "RESULTS_UNAVAILABLE" })
    // A notebook in its own per-job folder is unambiguous.
    gcs.putNotebook("gs://results/oc-schedule-token/scheduled-9/run.ipynb", outputNotebook("per job"), "2026-11-17T09:10:00Z")
    const result = (await runs.execution("work", { job: name, wait: 0 }, new AbortController().signal, read)) as Record<string, any>
    expect(result.cells[0].stdout).toBe("per job\n")
  })
})

describe("cancel finds the create LRO after a restart (request 4)", () => {
  it("uses the operation the ledger recorded when this process no longer has it", async () => {
    const { runner, runs, vertex, fakes, directory } = setup()
    const { forgetOperation } = await import("../../src/provider/enterprise/runs.js")
    const id = await createJob({ directory, runner })
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
    expect((await fakes.ledger.getRun(id))?.operation).toBe(vertex.operationNames[0])
    forgetOperation(name)
    expect(await runs.cancel("work", id, new AbortController().signal, read)).toMatchObject({ state: "ok", job: id, action: "cancelled" })
    expect(vertex.calls.filter((call) => call.method === "cancelOperation").at(-1)!.args[1]).toBe(vertex.operationNames[0])
    expect(vertex.jobs.get(name)!.state).toBe("JOB_STATE_CANCELLED")
  })

  it("finds a scheduled job's create operation with operations.list, asserting the read", async () => {
    const { runs, vertex } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/scheduled-1"
    vertex.putJob({ name, displayName: "scheduled", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z" })
    vertex.operations.set(name, [{ name: "projects/proj/locations/us-central1/operations/op-9", done: false }])
    const result = (await runs.cancel("work", name, new AbortController().signal, read)) as Record<string, unknown>
    expect(result).toMatchObject({ state: "ok", job: "scheduled-1", action: "cancel-requested" })
    expect(vertex.calls.some((call) => call.method === "listJobOperations")).toBe(true)
    expect(vertex.calls.filter((call) => call.method === "cancelOperation").at(-1)!.args[1]).toBe("projects/proj/locations/us-central1/operations/op-9")
    expect(reads).toContain("aiplatform.projects.locations.notebookExecutionJobs.operations.list")
  })
})
