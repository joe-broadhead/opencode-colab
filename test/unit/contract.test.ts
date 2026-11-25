// The tools' schemas and result shapes (design §6, §9): what each input takes and refuses, every result's envelope,
// and that every schema converts to JSON Schema for the host and the tools RPC.
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { PLAN_ACTION_NAMES } from "../../src/domain/actions.js"
import { CONTRACTS, Failure, PLAN_PARAMS } from "../../src/domain/contract.js"
import { OPERATIONS } from "../../src/domain/actions.js"
import type { DriveApi, EnterpriseSchedule, KernelSession, Listed, NotebookStore, RunRecord, RuntimeProtocol, VertexApi } from "../../src/provider/ports.js"
import { FakeBudget, FakeDrive, FakeDriveSync, FakeEnterpriseRuns, FakeNotebookStore, FakePrices, FakeRuntimeProtocol, FakeVertex } from "../fakes/index.js"

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const HASH = `sha256:${"a".repeat(64)}`

describe("inputs", () => {
  it("colab_run takes code or a notebook, never both, and cells only with a notebook", () => {
    const { input } = CONTRACTS.run
    expect(ok(input, { runtime: "oc-01", code: "print(1)" })).toBe(true)
    expect(ok(input, { runtime: "oc-01", notebook: { path: "a.ipynb" }, cells: "all" })).toBe(true)
    expect(ok(input, { runtime: "oc-01", notebook: { path: "a.ipynb" }, cells: { from: 0, to: 3 } })).toBe(true)
    expect(ok(input, { runtime: "oc-01" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", notebook: { path: "a.ipynb" } })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", cells: "all" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", allowStdin: true })).toBe(false)
  })

  it("colab_edit needs ifHash unless it creates, and create only first", () => {
    const { input } = CONTRACTS.edit
    expect(ok(input, { path: "a.ipynb", ops: [{ op: "create" }] })).toBe(true)
    expect(ok(input, { path: "a.ipynb", ifHash: HASH, ops: [{ op: "replace", cell: "c1", source: "x = 1" }] })).toBe(true)
    expect(ok(input, { path: "a.ipynb", ops: [{ op: "delete", cell: 0 }] })).toBe(false)
    expect(ok(input, { path: "a.ipynb", ifHash: HASH, ops: [{ op: "delete", cell: 0 }, { op: "create" }] })).toBe(false)
  })

  it("colab_download takes exactly one source", () => {
    const { input } = CONTRACTS.download
    expect(ok(input, { runtime: "oc-01", path: "/content/outputs/x.csv" })).toBe(true)
    expect(ok(input, { drive: "file-1" })).toBe(true)
    expect(ok(input, { gcs: "gs://bucket/out.ipynb" })).toBe(true)
    expect(ok(input, { drive: "file-1", gcs: "gs://bucket/x" })).toBe(false)
    expect(ok(input, { runtime: "oc-01" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", path: "relative.csv" })).toBe(false)
  })

  it("every plan action has params, and schedules and jobs take their bounds", () => {
    expect(Object.keys(PLAN_PARAMS).sort()).toEqual([...PLAN_ACTION_NAMES].sort())
    expect(ok(PLAN_PARAMS["schedule.create"], { notebook: { gcs: "gs://b/n.ipynb" }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 30 })).toBe(true)
    expect(ok(PLAN_PARAMS["job.create"], { notebook: { path: "a.ipynb" }, timeoutMinutes: 2000 })).toBe(false)
    expect(ok(PLAN_PARAMS["runtime.create"], { spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" }, keep: ["/content/outputs/**"] })).toBe(true)
  })

  it("an account alias is a short lowercase name", () => {
    expect(ok(CONTRACTS.status.input, { account: "work" })).toBe(true)
    expect(ok(CONTRACTS.status.input, { account: "Work Account" })).toBe(false)
  })
})

describe("results", () => {
  it("every tool's result accepts the failure envelope", () => {
    const failure = { state: "refused", error: "NOT_IMPLEMENTED", message: "x.", next: "y." }
    for (const [name, contract] of Object.entries(CONTRACTS)) {
      if (name === "events_list" || name === "runtimes_read") continue
      expect(ok(contract.output, failure), name).toBe(true)
    }
    expect(ok(Failure, { ...failure, error: "MADE_UP" })).toBe(false)
  })

  it("a run's result carries per-cell results and file paths, with running and detached states", () => {
    const cell = { id: "c1", state: "ok", executionCount: 1, ms: 12, stdout: "", stderr: "", rich: [{ mime: "image/png", path: ".colab/runs/r1/c1-0.png", bytes: 2048 }] }
    expect(ok(CONTRACTS.run.output, { state: "running", runId: "r1", cells: [cell], files: [], next: "colab_execution({ runId: \"r1\", wait: 60 })" })).toBe(true)
    expect(ok(CONTRACTS.execution.output, { state: "detached", runId: "r1", cells: [], files: [], warnings: ["DETACHED"] })).toBe(true)
    expect(ok(CONTRACTS.run.output, { state: "ok", runId: "r1", cells: [cell], files: [], warnings: ["NOT_A_WARNING"] })).toBe(false)
  })

  it("every schema converts to JSON Schema", () => {
    for (const [name, contract] of Object.entries(CONTRACTS)) {
      expect(() => z.toJSONSchema(contract.input, { io: "input", unrepresentable: "any" }), name).not.toThrow()
      expect(() => z.toJSONSchema(contract.output, { io: "output", unrepresentable: "any" }), name).not.toThrow()
    }
  })
})

describe("the runtime protocol port, as its fake implements it", () => {
  const target = { account: "default", runtimeId: "oc-01" }
  const signal = new AbortController().signal

  it("a kernel session starts and cancels the watchdog with the plugin's own number", async () => {
    const protocol = new FakeRuntimeProtocol()
    const session: KernelSession = await protocol.openSession(target, { name: "oc-n0nce-main", path: "a.ipynb" }, signal)
    await session.watchdog(1800, signal)
    await session.watchdog(null, signal)
    expect(protocol.opened[0]!.watchdogs).toEqual([1800, null])
  })

  it("files.read reads the whole file without a range, and a byte range with one, end inclusive", async () => {
    const protocol = new FakeRuntimeProtocol()
    protocol.contents.set("oc-01", new Map([["/content/outputs/x.csv", new TextEncoder().encode("0123456789")]]))
    const text = async (stream: AsyncIterable<Uint8Array>) => {
      let out = ""
      for await (const chunk of stream) out += new TextDecoder().decode(chunk)
      return out
    }
    const read: RuntimeProtocol["files"]["read"] = protocol.files.read
    expect(await text(await read(target, "/content/outputs/x.csv", signal))).toBe("0123456789")
    expect(await text(await read(target, "/content/outputs/x.csv", signal, { range: { start: 2, end: 4 } }))).toBe("234")
    expect(await text(await read(target, "/content/outputs/x.csv", signal, { range: { start: 7 } }))).toBe("789")
    expect(protocol.files.reads.map((entry) => entry.range)).toEqual([undefined, { start: 2, end: 4 }, { start: 7 }])
  })
})

describe("the Enterprise and seam ports, as their fakes and Day 0's stubs implement them", () => {
  const signal = new AbortController().signal

  it("colab_pause's result keeps state for the call and scheduleState for the schedule", () => {
    expect(ok(CONTRACTS.pause.output, { state: "ok", schedule: "schedules/1", scheduleState: "PAUSED" })).toBe(true)
    expect(ok(CONTRACTS.pause.output, { state: "PAUSED", schedule: "schedules/1" })).toBe(false)
  })

  it("a joined job create has no operation; the operations list finds a job's create LRO", async () => {
    const fake = new FakeVertex()
    const vertex: VertexApi = fake
    const first = await vertex.createJob("work", { jobId: "oc-job-1", body: {} }, signal)
    expect(first.operation).toBe("jobs/oc-job-1/operations/op-1")
    const joined = await vertex.createJob("work", { jobId: "oc-job-1", body: {} }, signal)
    expect(joined.operation).toBeUndefined()
    expect(await vertex.listJobOperations("work", "jobs/oc-job-1", signal)).toEqual([{ name: "jobs/oc-job-1/operations/op-1", done: false }])
  })

  it("schedules list with Google's exact display-name filter, and a list may say it was cut", async () => {
    const vertex: VertexApi = new FakeVertex()
    await vertex.createSchedule("work", { displayName: "nightly [oc-abcdefgh]", cron: "0 9 * * *" }, signal)
    await vertex.createSchedule("work", { displayName: "other", cron: "0 9 * * *" }, signal)
    expect((await vertex.listSchedules("work", { filter: 'display_name="nightly [oc-abcdefgh]"' }, signal)).map((item) => item.displayName)).toEqual(["nightly [oc-abcdefgh]"])
    const cut: Listed<EnterpriseSchedule> = Object.assign([] as EnterpriseSchedule[], { truncated: true })
    expect(cut.truncated).toBe(true)
  })

  it("EnterpriseRuns calls the tool's providerRead before its provider reads", async () => {
    const reads: string[] = []
    const read = async (operation: string) => void reads.push(operation)
    const runs = new FakeEnterpriseRuns()
    await runs.execution("work", { job: "jobs/1" }, signal, read)
    await runs.cancel("work", "jobs/1", signal, read)
    await runs.downloadGcs("work", { gcs: "gs://b/x" }, signal, read)
    expect(reads).toEqual([OPERATIONS.jobsGet, OPERATIONS.jobOperationsList, OPERATIONS.storageObjectsGet])
  })

  it("prices the machines the dated table knows", async () => {
    const prices = new FakePrices()
    expect(prices.usdPerHour({ machine: "e2-standard-4", accelerator: "T4" })).toBeCloseTo(0.59)
    expect(prices.usdPerHour({ machine: "e2-standard-4", region: "europe-west4" })).toBeUndefined()
    const run: RunRecord = { runId: "oc-job-1", account: "work", backend: "enterprise", job: "jobs/oc-job-1", operation: "jobs/oc-job-1/operations/op-1", cellIds: [], startedAt: "2026-11-17T09:00:00.000Z", state: "running", outputPaths: [] }
    expect(run.operation).toMatch(/operations/)
  })
})

describe("package C's ports, as their fakes implement them", () => {
  const signal = new AbortController().signal

  it("Drive: a pre-generated id to create with, and the kept-revision count", async () => {
    const fake = new FakeDrive()
    const drive: DriveApi = fake
    const id = await drive.generateId("home", signal)
    const file = await drive.create("home", { id, name: "a.ipynb", bytes: new Uint8Array(), mimeType: "application/vnd.google.colaboratory" }, signal)
    expect(file.id).toBe(id)
    await drive.keepRevision("home", id, "rev-1", signal)
    expect(await drive.keptRevisions("home", id, signal)).toEqual({ kept: 1, truncated: false })
  })

  it("DriveSync.pull calls the tool's providerRead before its Drive reads", async () => {
    const reads: string[] = []
    await new FakeDriveSync().pull("home", { drive: "file-1" }, signal, async (operation) => void reads.push(operation))
    expect(reads).toEqual([OPERATIONS.driveFilesGet])
  })

  it("NotebookStore merges a run by cell id, one merge per path at a time, and refuses a changed cell", async () => {
    const fake = new FakeNotebookStore()
    const store: NotebookStore = fake
    fake.set("a.ipynb", [{ id: "c1", source: "x = 1" }, { id: "c2", source: "print(x)" }])
    const read = await store.read("a.ipynb", signal)
    expect(read.cells.map((cell) => cell.id)).toEqual(["c1", "c2"])
    const [first, second] = await Promise.all([
      store.mergeRun("a.ipynb", { cells: [{ id: "c1", source: "x = 1", outputs: [], executionCount: 1 }], outputDir: ".colab/runs/r1" }, signal),
      store.mergeRun("a.ipynb", { cells: [{ id: "c2", source: "print(x)", outputs: [{ output_type: "stream" }], executionCount: 2 }], outputDir: ".colab/runs/r2" }, signal),
    ])
    expect(first.hash).not.toBe(second.hash)
    expect(fake.merges.map((merge) => merge.cells)).toEqual([["c1"], ["c2"]])
    await expect(store.mergeRun("a.ipynb", { cells: [{ id: "c1", source: "x = 2", outputs: [], executionCount: 3 }], outputDir: ".colab/runs/r3" }, signal)).rejects.toThrow(/^NOTEBOOK_CHANGED: /)
  })
})

describe("colab_cancel's result", () => {
  it("says cancel-requested when a job's cancel was accepted but the job has not stopped, and cancelled once it has", async () => {
    for (const action of ["interrupted", "restarted", "cancelled", "cancel-requested"]) expect(ok(CONTRACTS.cancel.output, { state: "ok", job: "jobs/1", action }), action).toBe(true)
    expect(ok(CONTRACTS.cancel.output, { state: "ok", job: "jobs/1", action: "stopping" })).toBe(false)
    // The fake reports what E must report for a job that is still running after the cancel.
    const result = await new FakeEnterpriseRuns().cancel("work", "jobs/1", new AbortController().signal, async () => undefined)
    expect(ok(CONTRACTS.cancel.output, result)).toBe(true)
    expect(result).toMatchObject({ action: "cancel-requested" })
  })
})

describe("a run's write-back result", () => {
  const base = { state: "ok", runId: "r1", cells: [], files: [] }
  const HASH = `sha256:${"b".repeat(64)}`

  it("says what landed: written with the hash, or skipped or refused with the run folder", () => {
    for (const output of [CONTRACTS.run.output, CONTRACTS.execution.output]) {
      expect(ok(output, base)).toBe(true)
      expect(ok(output, { ...base, writeBack: { state: "written", path: "a.ipynb", hash: HASH } })).toBe(true)
      expect(ok(output, { ...base, writeBack: { state: "skipped", runFolder: ".colab/runs/r1" } })).toBe(true)
      expect(ok(output, { ...base, writeBack: { state: "refused", error: "NOTEBOOK_CHANGED", path: "a.ipynb", runFolder: ".colab/runs/r1" } })).toBe(true)
      expect(ok(output, { ...base, writeBack: { state: "written", path: "a.ipynb" } })).toBe(false)
      expect(ok(output, { ...base, writeBack: { state: "refused", error: "MADE_UP", runFolder: ".colab/runs/r1" } })).toBe(false)
      expect(ok(output, { ...base, writeBack: { state: "skipped" } })).toBe(false)
    }
  })
})

describe("package F's contract", () => {
  const status = { state: "ok", accounts: [], runtimes: [], runs: [], cost: {}, cleanup: [], automation: "on", lastErrors: [] }

  it("colab_status may carry attention: up to 20 lines of at most 300 characters", () => {
    expect(ok(CONTRACTS.status.output, status)).toBe(true)
    expect(ok(CONTRACTS.status.output, { ...status, attention: ["oc-01: a run recorded running since 09:00 blocks its release; colab_cancel or a plan with force."] })).toBe(true)
    expect(ok(CONTRACTS.status.output, { ...status, attention: Array.from({ length: 21 }, (_, index) => `line ${index}`) })).toBe(false)
    expect(ok(CONTRACTS.status.output, { ...status, attention: ["x".repeat(301)] })).toBe(false)
  })

  it("a budget answer names its unit: USD for Enterprise, runtime-hours for consumer", async () => {
    const budget = new FakeBudget()
    budget.verdict = "refuse"
    expect(await budget.check("work", { action: "job.create", usd: 3 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 10, limit: 10, unit: "usd" })
    budget.unit = "runtime-hours"
    expect(await budget.check("home", { action: "runtime.create", runtimeHours: 1 }, new AbortController().signal)).toMatchObject({ unit: "runtime-hours" })
  })
})
