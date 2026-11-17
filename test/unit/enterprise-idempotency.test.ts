/**
 * Design §15.1 "Idempotency": a job's client-chosen `notebookExecutionJobId` joins on ALREADY_EXISTS, a create is never
 * sent twice by the plugin, and `schedules.create` — which has no id — is never retried and is reconciled by its unique
 * display-name token, answering UNCERTAIN when the token is not found (design §7.2, §8.6).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/deps.js"
import { ColabError } from "../../src/domain/errors.js"
import { createVertex, type VertexOptions } from "../../src/enterprise/vertex.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { toolHandlers } from "../../src/tools/registry.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_idempotency", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const OPTIONS = { accounts: { work: { backend: "enterprise" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function workspace(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-idempotency-"))
  directories.push(directory)
  const path = join(directory, "run.ipynb")
  writeFileSync(path, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: ["print(1)"] }] }))
  return { directory, path }
}

function setup(directory: string) {
  const { deps: base, fakes } = fakeDeps({ options: OPTIONS, directory })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  const permission = new RecordingPermission()
  let runner: Runner
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
  return { deps, fakes, vertex, gcs, runner }
}

/** A fetch that answers one scripted response per call, and records every request. */
function scriptedFetch(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; method: string; body?: unknown; authorization?: string }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? "GET",
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
      ...(init?.headers ? { authorization: (init.headers as Record<string, string>).authorization } : {}),
    })
    const next = responses.shift()
    if (!next) throw new Error("the test ran out of scripted responses")
    return new Response(next.body === undefined ? "" : JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

function client(fetchImpl: typeof fetch, options: VertexOptions = {}) {
  const { deps, fakes } = fakeDeps({ options: OPTIONS })
  fakes.auth.grants.set("work", ["https://www.googleapis.com/auth/cloud-platform"])
  return { vertex: createVertex({ options: deps.options, directory: deps.directory, clock: deps.clock, auth: fakes.auth, ledger: fakes.ledger, fetch: fetchImpl }, { retryDelayMs: 0, ...options }), fakes }
}

describe("a job's client-chosen id", () => {
  it("is the id the preview shows, the query the create sends, and the run id recorded", async () => {
    const { directory, path } = workspace()
    const { vertex, runner, fakes } = setup(directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    await runTool("write", { planId: planned.planId }, call(), runner)
    expect(vertex.jobBodies[0]!.jobId).toBe(planned.preview.jobId)
    expect((vertex.calls.find((entry) => entry.method === "createJob")!.args[1] as { jobId: string }).jobId).toBe(planned.preview.jobId)
    expect(await fakes.ledger.getRun(planned.preview.jobId)).toBeDefined()
  })

  it("joins a job that already exists instead of creating a second one", async () => {
    const { directory, path } = workspace()
    const { vertex, runner } = setup(directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    const name = `projects/proj/locations/us-central1/notebookExecutionJobs/${planned.preview.jobId}`
    vertex.putJob({ name, displayName: "the first create", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z" })
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", result: { id: planned.preview.jobId, displayName: "run.ipynb" } })
    expect(vertex.jobs.size).toBe(1)
    // A plan is single use, so the plugin cannot send the same create twice through the route.
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ error: "PLAN_ALREADY_USED" })
  })

  it("joins at the client when Google answers ALREADY_EXISTS, and never retries a create", async () => {
    const job = { name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-1", displayName: "first", jobState: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z" }
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 409, body: { error: { code: 409, status: "ALREADY_EXISTS", message: "already exists" } } },
      { status: 200, body: job },
    ])
    const { vertex } = client(fetchImpl)
    const joined = await vertex.createJob("work", { jobId: "oc-job-1", body: { displayName: "first" } }, new AbortController().signal)
    expect(joined).toMatchObject({ job: { name: job.name, state: "JOB_STATE_RUNNING" }, operation: "" })
    expect(calls.map((entry) => entry.method)).toEqual(["POST", "GET"])
    expect(calls[0]!.url).toContain("notebookExecutionJobId=oc-job-1")
    expect(calls[0]!.authorization).toBe("Bearer fake-token-work")
    // A server error on a create is not retried: schedules have no id, and a job join is the client's own step.
    const failed = scriptedFetch([{ status: 500, body: { error: { code: 500, message: "boom" } } }])
    const second = client(failed.fetch)
    await expect(second.vertex.createJob("work", { jobId: "oc-job-2", body: {} }, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(failed.calls).toHaveLength(1)
  })
})

describe("a schedule's display-name token", () => {
  it("is in the display name the create sends, and the create is sent once", async () => {
    const { directory, path } = workspace()
    const { vertex, runner } = setup(directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 5 } }, call(), runner)) as { planId: string; preview: Record<string, any> }
    await runTool("write", { planId: planned.planId }, call(), runner)
    expect(vertex.scheduleBodies).toHaveLength(1)
    expect(String(vertex.scheduleBodies[0]!.displayName)).toContain(`[oc-${planned.preview.scheduleToken}]`)
  })

  it("reconciles a lost answer by listing on the token, without a second create", async () => {
    const { directory, path } = workspace()
    const { vertex, runner } = setup(directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 5 } }, call(), runner)) as { planId: string }
    vertex.loseNextScheduleCreate = true
    const committed = (await runTool("write", { planId: planned.planId }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", result: { id: "1", message: expect.stringContaining("display-name token") } })
    expect(vertex.scheduleBodies).toHaveLength(1)
    expect(vertex.schedules.size).toBe(1)
  })

  it("answers UNCERTAIN when the lost answer left no schedule, and does not try again", async () => {
    const { directory, path } = workspace()
    const { vertex, runner } = setup(directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 5 } }, call(), runner)) as { planId: string }
    vertex.failNextScheduleCreate = new ColabError("UNAVAILABLE", "The create's answer was lost.")
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "failed", error: "UNCERTAIN", next: expect.stringContaining("colab_schedules") })
    expect(vertex.scheduleBodies).toHaveLength(1)
    expect(vertex.schedules.size).toBe(0)
  })
})
