/**
 * `colab_schedules`, `colab_pause` and the schedule plans (design §6, §7.2, §8.2): the cron and its zone, the next five
 * runs, the bounds, the per-run and per-month worst case, the unique display-name token, pause as a direct change, and
 * update / resume / delete through plans whose commit re-reads the schedule. No Google call: the fake keeps the job
 * request inside the schedule, as Google does.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/provider/index.js"
import { CONTRACTS } from "../../src/domain/contract.js"
import { ColabError } from "../../src/domain/errors.js"
import { runTool, type Runner } from "../support/legacy.js"
import { toolHandlers } from "../support/legacy.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_schedules", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const WORK = { backend: "enterprise" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" }
const OPTIONS = { accounts: { work: WORK } }

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-schedules-"))
  directories.push(directory)
  const path = join(directory, "daily.ipynb")
  writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: ["print(1)"] }] }))
  return { directory, path }
}

function setup(options: unknown = OPTIONS, directory?: string) {
  const { deps: base, fakes } = fakeDeps({ options, ...(directory !== undefined ? { directory } : {}) })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  const permission = new RecordingPermission()
  let runner: Runner
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
  return { deps, fakes, vertex, gcs, permission, runner }
}

const schedule = (input: { readonly name?: string; readonly displayName?: string; readonly cron?: string; readonly state?: string; readonly maxRunCount?: number; readonly startedRunCount?: number; readonly endTime?: string }) => ({
  name: input.name ?? "projects/proj/locations/us-central1/schedules/1",
  displayName: input.displayName ?? "nightly",
  cron: input.cron ?? "0 9 * * *",
  state: input.state ?? "ACTIVE",
  ...(input.maxRunCount !== undefined ? { maxRunCount: input.maxRunCount } : {}),
  ...(input.startedRunCount !== undefined ? { startedRunCount: input.startedRunCount } : {}),
  ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
  jobRequest: {
    parent: "projects/proj/locations/us-central1",
    notebookExecutionJob: {
      displayName: "nightly run",
      executionTimeout: "3600s",
      customEnvironmentSpec: { machineSpec: { machineType: "e2-standard-4" } },
      gcsOutputUri: "gs://results",
    },
  },
})

describe("schedule.create", () => {
  it("sends a bounded, non-overlapping schedule whose job request carries the labels and no job id", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, permission } = setup(OPTIONS, directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", timeZone: "America/New_York", maxRunCount: 30 } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    expect(planned.preview).toMatchObject({ scheduleToken: expect.stringMatching(/^[0-9a-z]{8}$/), cron: "TZ=America/New_York 0 9 * * *", cost: { perRunUsd: 0.22, runsPerMonth: 30 } })
    expect(planned.preview.nextRuns).toHaveLength(5)
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", action: "schedule.create", result: { id: "1", state: "ACTIVE", perRunUsd: 0.22 } })
    expect(vertex.scheduleBodies).toHaveLength(1)
    const body = vertex.scheduleBodies[0] as Record<string, any>
    expect(body).toMatchObject({
      displayName: expect.stringContaining(`[oc-${planned.preview.scheduleToken}]`),
      cron: "TZ=America/New_York 0 9 * * *",
      maxRunCount: "30",
      maxConcurrentRunCount: "1",
      allowQueueing: false,
      createNotebookExecutionJobRequest: {
        parent: "projects/proj/locations/us-central1",
        notebookExecutionJob: {
          executionTimeout: "3600s",
          customEnvironmentSpec: { machineSpec: { machineType: "e2-standard-4" } },
          serviceAccount: "runner@proj.iam.gserviceaccount.com",
          labels: { oc_plugin: "colab" },
          gcsOutputUri: `gs://results/${planned.preview.scheduleToken}/`,
        },
      },
    })
    expect(body.createNotebookExecutionJobRequest.notebookExecutionJob.notebookExecutionJobId).toBeUndefined()
    expect(body.createNotebookExecutionJobRequest.notebookExecutionJob.directNotebookSource.content).toEqual(expect.any(String))
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.plan", ["work"]],
      ["colab.write", ["work:aiplatform.projects.locations.schedules.create"]],
    ])
  })
})

describe("colab_schedules", () => {
  it("shows cron, next runs, bounds and the worst case, resolving a template's machine", async () => {
    const { runner, vertex } = setup()
    vertex.templates = [{ name: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", machineSpec: { machineType: "e2-standard-4" } }]
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", {
      ...schedule({ maxRunCount: 10, startedRunCount: 2 }),
      jobRequest: { parent: "projects/proj/locations/us-central1", notebookExecutionJob: { notebookRuntimeTemplateResourceName: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", executionTimeout: "3600s" } },
    } as never)
    const listed = (await runTool("schedules", { account: "work" }, call(), runner)) as { state: string; schedules: Record<string, unknown>[]; trust: string }
    expect(listed).toMatchObject({ state: "ok", trust: "untrusted" })
    expect(listed.schedules[0]).toMatchObject({ id: "1", displayName: "nightly", cron: "0 9 * * *", state: "ACTIVE", runsStarted: 2, maxRunCount: 10, worstCaseUsdPerRun: 0.22 })
    expect(listed.schedules[0]!.nextRuns).toHaveLength(5)
    expect(listed.schedules[0]!.worstCaseUsdPerMonth).toBeGreaterThan(0)
    const one = (await runTool("schedules", { account: "work", schedule: "1" }, call(), runner)) as { schedules: unknown[] }
    expect(one.schedules).toHaveLength(1)
    expect(await runTool("schedules", { account: "work", schedule: "missing" }, call(), runner)).toMatchObject({ error: "NOT_FOUND" })
  })
})

describe("colab_pause", () => {
  it("pauses a schedule directly, is idempotent, and says when there is nothing to pause", async () => {
    const { runner, vertex, permission } = setup()
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({}))
    const result = await runTool("pause", { account: "work", schedule: "1" }, call(), runner)
    expect(result).toMatchObject({ state: "ok", schedule: "1", scheduleState: "PAUSED" })
    // The contract's PauseOutput reuses `state` for the schedule's state; its own schema accepts this result.
    expect(CONTRACTS.pause.output.safeParse(result).success).toBe(true)
    expect(vertex.schedules.get("projects/proj/locations/us-central1/schedules/1")!.state).toBe("PAUSED")
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.pause", ["work"]],
      ["colab.read", ["work:aiplatform.projects.locations.schedules.get"]],
    ])
    expect(await runTool("pause", { account: "work", schedule: "1" }, call(), runner)).toMatchObject({ state: "ok", scheduleState: "PAUSED", message: expect.stringContaining("already paused") })
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ state: "COMPLETED" }))
    expect(await runTool("pause", { account: "work", schedule: "1" }, call(), runner)).toMatchObject({ error: "ACTION_UNSUPPORTED" })
  })
})

describe("schedule.update", () => {
  it("changes the cron with an updateMask, on top of the schedule's own timeout", async () => {
    const { runner, vertex } = setup()
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ maxRunCount: 5 }))
    // 09:00 and 10:00 are an hour apart, under the 60-minute timeout plus the 10-minute margin.
    expect(await runTool("plan", { action: "schedule.update", account: "work", params: { schedule: "1", cron: "0 9,10 * * *", maxRunCount: 8 } }, call(), runner)).toMatchObject({ error: "SCHEDULE_OVERLAP", message: expect.stringContaining("70 minutes") })
    const planned = (await runTool("plan", { action: "schedule.update", account: "work", params: { schedule: "1", cron: "0 9,11 * * *", maxRunCount: 8 } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    expect(planned.preview).toMatchObject({ changes: { cron: "0 9,11 * * *", maxRunCount: 8 }, bounds: { maxRunCount: 8 }, minimumGapMinutes: 120, requiredGapMinutes: 70 })
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "ok", result: { cron: "0 9,11 * * *" } })
    const body = vertex.calls.filter((entry) => entry.method === "updateSchedule").at(-1)!.args[2] as Record<string, unknown>
    expect(body).toMatchObject({ updateMask: "cron,maxRunCount", cron: "0 9,11 * * *", maxRunCount: "8" })
  })

  it("refuses a change that leaves the schedule unbounded, and a schedule that moved since the preview", async () => {
    const { runner, vertex } = setup()
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ endTime: "2026-12-31T00:00:00Z" }))
    expect(await runTool("plan", { action: "schedule.update", account: "work", params: { schedule: "1", endTime: "" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    const planned = (await runTool("plan", { action: "schedule.update", account: "work", params: { schedule: "1", maxRunCount: 4 } }, call(), runner)) as { planId: string }
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ maxRunCount: 2, endTime: "2026-12-31T00:00:00Z" }))
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ error: "PLAN_CHANGED" })
  })
})

describe("schedule.resume and schedule.delete", () => {
  it("resumes only a paused schedule, and deletes one without touching the runs it started", async () => {
    const { runner, vertex } = setup()
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ state: "PAUSED", maxRunCount: 3, startedRunCount: 1 }))
    const resumed = (await runTool("plan", { action: "schedule.resume", account: "work", params: { schedule: "1" } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    expect(resumed.preview).toMatchObject({ schedule: { state: "PAUSED" }, catchUp: expect.stringContaining("not backfilled") })
    expect(await runTool("write", { planId: resumed.planId }, call(), runner)).toMatchObject({ state: "ok", result: { state: "ACTIVE" } })
    expect(vertex.schedules.get("projects/proj/locations/us-central1/schedules/1")!.state).toBe("ACTIVE")
    // An active schedule has nothing to resume.
    expect(await runTool("plan", { action: "schedule.resume", account: "work", params: { schedule: "1" } }, call(), runner)).toMatchObject({ error: "ACTION_UNSUPPORTED" })
    const deleted = (await runTool("plan", { action: "schedule.delete", account: "work", params: { schedule: "1" } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    expect(deleted.preview).toMatchObject({ deletes: expect.stringContaining("no new runs"), keeps: expect.stringContaining("runs it already started") })
    expect(await runTool("delete", { planId: deleted.planId }, call(), runner)).toMatchObject({ state: "ok", result: { deleted: true } })
    expect(vertex.schedules.size).toBe(0)
  })
})

describe("foreign schedules and lost answers (review LOW 8, M1)", () => {
  it("refuses to update or resume a schedule that starts several runs at once or queues them", async () => {
    const { runner, vertex } = setup()
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/9", {
      ...schedule({ state: "PAUSED", maxRunCount: 5 }),
      maxConcurrentRunCount: 2,
      allowQueueing: true,
    } as never)
    expect(await runTool("plan", { action: "schedule.update", account: "work", params: { schedule: "9", maxRunCount: 6 } }, call(), runner)).toMatchObject({ error: "SCHEDULE_OVERLAP", message: expect.stringContaining("2 runs at once") })
    expect(await runTool("plan", { action: "schedule.resume", account: "work", params: { schedule: "9" } }, call(), runner)).toMatchObject({ error: "SCHEDULE_OVERLAP" })
  })

  it("reconciles a create stopped with CANCELLED by its display-name token", async () => {
    const { directory, path } = workspace()
    const { runner, vertex } = setup(OPTIONS, directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 5 } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    vertex.schedules.set("projects/proj/locations/us-central1/schedules/1", schedule({ displayName: `nightly [oc-${planned.preview.scheduleToken}]` }))
    vertex.failNextScheduleCreate = new ColabError("CANCELLED", "The call stopped before the create's answer.")
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", result: { message: expect.stringContaining("display-name token") } })
    expect(vertex.scheduleBodies).toHaveLength(1)
  })
})
