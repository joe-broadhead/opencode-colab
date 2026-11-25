/**
 * Design §15.1 "Idempotency": a job's client-chosen `notebookExecutionJobId` joins on ALREADY_EXISTS, a create is never
 * sent twice by the plugin, and `schedules.create` — which has no id — is never retried and is reconciled by its unique
 * display-name token, answering UNCERTAIN when the token is not found (design §7.2, §8.6).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/provider/index.js"
import { ColabError } from "../../src/domain/errors.js"
import { createVertex, type VertexOptions } from "../../src/provider/enterprise/vertex.js"
import { runTool, type Runner } from "../support/legacy.js"
import { toolHandlers } from "../support/legacy.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_idempotency", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const OPTIONS = { accounts: { work: { backend: "enterprise" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }

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

function setup(directory: string, shared?: Deps["ledger"]) {
  const { deps: base, fakes } = fakeDeps({ options: OPTIONS, directory })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  // A shared ledger models a second process: the record written before a create survives the restart.
  const deps: Deps = { ...base, vertex, gcs, ...(shared !== undefined ? { ledger: shared } : {}) }
  const permission = new RecordingPermission()
  let runner: Runner
  const handlers = toolHandlers(() => runner)
  runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
  return { deps, fakes, vertex, gcs, runner, ledger: deps.ledger }
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
    expect(await fakes.ledger.getRun(planned.preview.jobId)).toMatchObject({ operation: vertex.operationNames[0] })
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

  it("joins at the client on ALREADY_EXISTS, and retries a lost create with the same id before looking it up", async () => {
    const job = { name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-1", displayName: "first", jobState: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z" }
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 409, body: { error: { code: 409, status: "ALREADY_EXISTS", message: "already exists" } } },
      { status: 200, body: job },
    ])
    const { vertex } = client(fetchImpl)
    const joined = await vertex.createJob("work", { jobId: "oc-job-1", body: { displayName: "first" } }, new AbortController().signal)
    expect(joined.job).toMatchObject({ name: job.name, state: "JOB_STATE_RUNNING" })
    expect(joined.operation).toBeUndefined()
    expect(calls.map((entry) => entry.method)).toEqual(["POST", "GET"])
    expect(calls[0]!.url).toContain("notebookExecutionJobId=oc-job-1")
    expect(calls[0]!.authorization).toBe("Bearer fake-token-work")
    // A server error is retried with the same id (a retry joins the first job), then looked up; a create that never
    // landed is UNCERTAIN, so the next plan knows to check before making another.
    const failed = scriptedFetch([
      { status: 500, body: { error: { code: 500, message: "boom" } } },
      { status: 500, body: { error: { code: 500, message: "boom" } } },
      { status: 500, body: { error: { code: 500, message: "boom" } } },
      { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "no job" } } },
    ])
    const second = client(failed.fetch)
    await expect(second.vertex.createJob("work", { jobId: "oc-job-2", body: {} }, new AbortController().signal)).rejects.toMatchObject({ code: "UNCERTAIN" })
    expect(failed.calls.filter((call) => call.method === "POST")).toHaveLength(3)
    expect(failed.calls.every((call) => call.method === "POST" ? call.url.includes("notebookExecutionJobId=oc-job-2") : true)).toBe(true)
    expect(failed.calls.at(-1)!.url).toContain("/notebookExecutionJobs/oc-job-2")
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

describe("a lost create answer (review M1)", () => {
  it("P1: a 5xx is retried with the same job id, and the retry's job is joined", async () => {
    const job = { name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-x", displayName: "x", jobState: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z" }
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 503, body: { error: { code: 503, status: "UNAVAILABLE", message: "backend" } } },
      { status: 200, body: { name: "projects/proj/locations/us-central1/operations/op-1", response: job } },
    ])
    const { vertex } = client(fetchImpl)
    const created = await vertex.createJob("work", { jobId: "oc-job-x", body: {} }, new AbortController().signal)
    expect(created).toMatchObject({ job: { name: job.name }, operation: "projects/proj/locations/us-central1/operations/op-1" })
    expect(calls.map((call) => call.method)).toEqual(["POST", "POST"])
    expect(calls.every((call) => call.url.includes("notebookExecutionJobId=oc-job-x"))).toBe(true)
  })

  it("P1: a 5xx that never landed is looked up by id and answers UNCERTAIN, not UNAVAILABLE", async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "no job" } } },
    ])
    const { vertex } = client(fetchImpl)
    await expect(vertex.createJob("work", { jobId: "oc-job-y", body: {} }, new AbortController().signal)).rejects.toMatchObject({ code: "UNCERTAIN", next: "colab_jobs lists the account's jobs before planning again." })
    expect(calls.at(-1)!.url).toContain("/notebookExecutionJobs/oc-job-y")
  })

  it("looks through the operations list and answers UNCERTAIN while the create operation still runs", async () => {
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 503, body: { error: { code: 503, message: "backend" } } },
      { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "no job yet" } } },
      { status: 200, body: { operations: [{ name: "projects/proj/locations/us-central1/operations/op-5", done: false }] } },
    ])
    const { vertex } = client(fetchImpl)
    await expect(vertex.createJob("work", { jobId: "oc-job-op", body: {} }, new AbortController().signal)).rejects.toMatchObject({ code: "UNCERTAIN", message: expect.stringContaining("still running") })
    expect(calls.at(-1)!.url).toContain("/notebookExecutionJobs/oc-job-op/operations")
  })

  it("P1b: a 409 ALREADY_EXISTS with an ErrorInfo reason joins by HTTP status", async () => {
    const job = { name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-z", displayName: "z", jobState: "JOB_STATE_RUNNING" }
    const { fetch: fetchImpl, calls } = scriptedFetch([
      { status: 409, body: { error: { code: 409, status: "ALREADY_EXISTS", message: "exists", details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "RESOURCE_EXISTS", domain: "aiplatform.googleapis.com" }] } } },
      { status: 200, body: job },
    ])
    const { vertex } = client(fetchImpl)
    const joined = await vertex.createJob("work", { jobId: "oc-job-z", body: {} }, new AbortController().signal)
    expect(joined.job).toMatchObject({ name: job.name })
    expect(joined.operation).toBeUndefined()
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"])
  })

  it("reconciles an aborted create with a fresh signal and names the job the Stop left behind", async () => {
    const controller = new AbortController()
    const job = { name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-stop", displayName: "stop", jobState: "JOB_STATE_RUNNING" }
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") {
        controller.abort()
        throw Object.assign(new Error("aborted"), { name: "AbortError" })
      }
      return new Response(JSON.stringify(job), { status: 200 })
    }) as typeof fetch
    const { vertex } = client(fetchImpl)
    await expect(vertex.createJob("work", { jobId: "oc-job-stop", body: {} }, controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
      next: expect.stringContaining('colab_execution({ job: "oc-job-stop" })'),
    })
  })

  it("answers UNCERTAIN when the client cannot confirm a committed job create", async () => {
    const { directory, path } = workspace()
    const { vertex, runner, fakes } = setup(directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { planId: string; preview: { jobId: string } }
    vertex.failNextCreate = new ColabError("UNCERTAIN", "The job create's answer was lost, and no job with its id exists.", { next: "colab_jobs lists the account's jobs before planning again." })
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "failed", error: "UNCERTAIN", next: "colab_jobs lists the account's jobs before planning again." })
    // The plan is spent (a failed commit expires it), and the create's intent is in the ledger, unresolved.
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ state: "refused", error: "PLAN_EXPIRED" })
    expect(fakes.ledger.runs.size).toBe(1)
  })
})


describe("a create's intent is in the ledger before the call (review R1)", () => {
  const jobName = (id: string) => `projects/proj/locations/us-central1/notebookExecutionJobs/${id}`
  const plan = async (runner: Runner, path: string) => (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { planId: string; preview: Record<string, any> }

  it("a create that times out leaves an UNCERTAIN record, and a second create is blocked while its job exists", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, ledger } = setup(directory)
    const first = await plan(runner, path)
    vertex.failNextCreate = new ColabError("UNCERTAIN", "The job create's answer was lost, and no job with its id exists.", { next: "colab_jobs lists the account's jobs before planning again." })
    expect(await runTool("write", { planId: first.planId }, call(), runner)).toMatchObject({ state: "failed", error: "UNCERTAIN" })
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running", errorCode: "UNCERTAIN", notebook: path })
    expect((await ledger.getRun(first.preview.jobId))!.endedAt).toBeUndefined()
    // Now the job exists (the answer was lost, the create was not): a new plan must not create a second one.
    vertex.putJob({ name: jobName(first.preview.jobId), displayName: "first", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z" })
    vertex.operations.set(jobName(first.preview.jobId), [{ name: "projects/proj/locations/us-central1/operations/op-lost", done: false }])
    const second = await plan(runner, path)
    expect(await runTool("write", { planId: second.planId }, call(), runner)).toMatchObject({
      error: "UNCERTAIN",
      message: expect.stringContaining(first.preview.jobId),
      next: expect.stringContaining("job.delete"),
    })
    expect(vertex.jobBodies).toHaveLength(1)
    // The record is reconciled to the real job, with its create operation.
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running", operation: "projects/proj/locations/us-central1/operations/op-lost" })
    expect((await ledger.getRun(first.preview.jobId))!.errorCode).toBeUndefined()
    // Once the record is confirmed (the job and its operation are known), it no longer blocks a new plan; deleting the
    // job and creating another is then an ordinary, deliberate pair of steps.
    vertex.jobs.delete(jobName(first.preview.jobId))
    const third = await plan(runner, path)
    expect(await runTool("write", { planId: third.planId }, call(), runner)).toMatchObject({ state: "ok", result: { id: third.preview.jobId } })
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running" })
    expect((await ledger.getRun(first.preview.jobId))!.errorCode).toBeUndefined()
  })

  it("a create stopped mid-call leaves a record, and the next create reuses its id (R3)", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, ledger } = setup(directory)
    const first = await plan(runner, path)
    vertex.failNextCreate = new ColabError("CANCELLED", "The call stopped before the job's create was confirmed.", { next: "colab_jobs lists the account's jobs before planning again." })
    expect(await runTool("write", { planId: first.planId }, call(), runner)).toMatchObject({ state: "failed", error: "CANCELLED" })
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running", errorCode: "UNCERTAIN" })
    // The job is absent and Google answers 404 for it and its operations: the next plan retries with the same id, so a
    // late-arriving create joins rather than doubling.
    const second = await plan(runner, path)
    const committed = (await runTool("write", { planId: second.planId }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", result: { id: first.preview.jobId, message: expect.stringContaining("reused its id") } })
    expect(vertex.jobBodies.map((entry) => entry.jobId)).toEqual([first.preview.jobId, first.preview.jobId])
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running", operation: expect.any(String) })
    expect((await ledger.getRun(first.preview.jobId))!.errorCode).toBeUndefined()
  })

  it("keeps the record UNCERTAIN when the reconcile's lookup fails transiently", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, ledger } = setup(directory)
    const first = await plan(runner, path)
    vertex.failNextCreate = new ColabError("UNCERTAIN", "The job create's answer was lost.", { next: "colab_jobs lists the account's jobs before planning again." })
    await runTool("write", { planId: first.planId }, call(), runner)
    vertex.failNextGetJob = new ColabError("UNAVAILABLE", "Google answered 5xx after retries.")
    const second = await plan(runner, path)
    expect(await runTool("write", { planId: second.planId }, call(), runner)).toMatchObject({
      error: "UNCERTAIN",
      message: expect.stringContaining(first.preview.jobId),
      next: expect.stringContaining("Check colab_jobs"),
    })
    expect(await ledger.getRun(first.preview.jobId)).toMatchObject({ state: "running", errorCode: "UNCERTAIN" })
    expect(vertex.jobBodies).toHaveLength(1)
  })

  it("a process restart still sees the record and blocks a second job for the same notebook", async () => {
    const { directory, path } = workspace()
    const first = setup(directory)
    const planned = await plan(first.runner, path)
    first.vertex.failNextCreate = new ColabError("UNCERTAIN", "The job create's answer was lost.", { next: "colab_jobs lists the account's jobs before planning again." })
    await runTool("write", { planId: planned.planId }, call(), first.runner)
    // A new Deps (a restarted OpenCode) with the same ledger, and the lost create's job now visible.
    const restarted = setup(directory, first.ledger)
    restarted.vertex.putJob({ name: jobName(planned.preview.jobId), displayName: "first", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z" })
    restarted.vertex.operations.set(jobName(planned.preview.jobId), [{ name: "projects/proj/locations/us-central1/operations/op-restart", done: false }])
    const next = await plan(restarted.runner, path)
    expect(await runTool("write", { planId: next.planId }, call(), restarted.runner)).toMatchObject({ error: "UNCERTAIN", message: expect.stringContaining(planned.preview.jobId) })
    expect(restarted.vertex.jobBodies).toHaveLength(0)
    expect(await restarted.ledger.getRun(planned.preview.jobId)).toMatchObject({ operation: "projects/proj/locations/us-central1/operations/op-restart" })
  })

  it("settles the record when the create is definitively refused", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, ledger } = setup(directory)
    const planned = await plan(runner, path)
    vertex.failNextCreate = new ColabError("PERMISSION_DENIED", "The run identity cannot create jobs.")
    expect(await runTool("write", { planId: planned.planId }, call(), runner)).toMatchObject({ error: "PERMISSION_DENIED" })
    expect(await ledger.getRun(planned.preview.jobId)).toMatchObject({ state: "failed", errorCode: "PERMISSION_DENIED", endedAt: expect.any(String) })
    expect(vertex.jobBodies).toHaveLength(1)
  })
})
