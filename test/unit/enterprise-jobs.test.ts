/**
 * `colab_jobs` and the `job.create` / `job.delete` plans (design §6, §7.2): the direct-source body, the client-chosen
 * job id, compute from customEnvironmentSpec or a template, the run identity (Q9), the bucket (BUCKET_REQUIRED), the
 * secret screen, the ledger record, and a commit that re-reads the notebook. The fakes reproduce the shapes L10 will
 * confirm (directNotebookSource, executionTimeout, customEnvironmentSpec with e2-standard-4); L10 itself remains unrun.
 */
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/provider/index.js"
import { runTool, type Runner } from "../support/methods.js"
import { fakeDeps } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"
import { invented } from "../support/invented.js"

const call = (sessionID = "ses_enterprise") => ({ sessionID, agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const WORK = { backend: "enterprise" as const, mode: "adc" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" }
const OPTIONS = { accounts: { work: WORK } }

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function notebook(cells: unknown[] = [{ cell_type: "code", id: "code-1", metadata: {}, execution_count: null, outputs: [], source: ["print('hi')"] }]) {
  return { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "python3", language: "python" } }, cells }
}

function workspace(bytes: unknown = notebook(), name = "analysis.ipynb"): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-jobs-"))
  directories.push(directory)
  const path = join(directory, name)
  writeFileSync(path, typeof bytes === "string" ? bytes : JSON.stringify(bytes))
  return { directory, path }
}

function setup(options: unknown = OPTIONS, directory?: string) {
  const { deps: base, fakes } = fakeDeps({ options, ...(directory !== undefined ? { directory } : {}) })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  let runner: Runner
  runner = { deps }
  return { deps, fakes, vertex, gcs, runner }
}

describe("the account's prerequisites", () => {
  it("needs an enterprise account, a project and region, a bucket and a run identity", async () => {
    const { directory, path } = workspace()
    const consumer = setup({ accounts: { default: {} } }, directory)
    expect(await runTool("plan", { action: "job.create", params: { notebook: { path } } }, call(), consumer.runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    const noProject = setup({ accounts: { work: { backend: "enterprise", access: "write" } } }, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), noProject.runner)).toMatchObject({ error: "OPTIONS_INVALID" })
    const noBucket = setup({ accounts: { work: { backend: "enterprise", access: "write", project: "proj", region: "us-central1", serviceAccount: "s@proj.iam.gserviceaccount.com" } } }, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), noBucket.runner)).toMatchObject({ error: "OPTIONS_INVALID" })
    const noIdentity = setup({ accounts: { work: { backend: "enterprise", access: "write", project: "proj", region: "us-central1", outputBucket: "gs://b" } } }, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), noIdentity.runner)).toMatchObject({ error: "OPTIONS_INVALID", next: expect.stringContaining("serviceAccount") })
  })

  it("runs as the person only with runAsUser: true, and needs their identity then", async () => {
    const { directory, path } = workspace()
    const options = { accounts: { work: { ...WORK, serviceAccount: undefined, runAsUser: true } } }
    const { runner, fakes } = setup(options, directory)
    fakes.auth.emails.set("work", "person@example.com")
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { preview: Record<string, unknown>; plan: unknown }
    expect(planned.preview).toMatchObject({ identity: { as: "user", label: "you (person@example.com)" } })
    const withoutIdentity = setup(options, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), withoutIdentity.runner)).toMatchObject({ error: "NEEDS_SIGN_IN" })
  })
})

describe("job.create", () => {
  it("sends the direct notebook source, customEnvironmentSpec, the timeout, the service account and the labels", async () => {
    const { directory, path } = workspace()
    const { runner, vertex, fakes } = setup(OPTIONS, directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { plan: unknown; preview: Record<string, any> }
    const jobId = planned.preview.jobId as string
    const committed = (await runTool("write", { plan: planned.plan }, call(), runner)) as { state: string; result: Record<string, unknown> }
    expect(committed).toMatchObject({ state: "ok", action: "job.create", result: { id: jobId, state: "JOB_STATE_RUNNING", estimateUsd: 0.22, pricesAsOf: "2026-11-17" } })
    expect(vertex.jobBodies).toHaveLength(1)
    const body = vertex.jobBodies[0]!.body
    expect(body).toMatchObject({
      displayName: "analysis.ipynb",
      customEnvironmentSpec: { machineSpec: { machineType: "e2-standard-4" } },
      gcsOutputUri: `gs://results/${jobId}/`,
      executionTimeout: "3600s",
      serviceAccount: "runner@proj.iam.gserviceaccount.com",
      labels: { oc_plugin: "colab" },
    })
    expect(body.notebookRuntimeTemplateResourceName).toBeUndefined()
    expect(Buffer.from((body.directNotebookSource as { content: string }).content, "base64").toString("utf8")).toBe(JSON.stringify(notebook()))
    expect(vertex.jobBodies[0]!.jobId).toBe(jobId)
    expect(await fakes.ledger.getRun(jobId)).toMatchObject({ state: "running", backend: "enterprise" })
  })

  it("reports secret-shaped cell sources in the preview without their text", async () => {
    const secret = invented("AIza", "SyD-1234567890abcdefghijklmnopqrstu")
    const { directory, path } = workspace(notebook([{ cell_type: "code", id: "c1", metadata: {}, execution_count: null, outputs: [], source: [`key = "${secret}"`] }]))
    const { runner } = setup(OPTIONS, directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { preview: Record<string, any> }
    expect(planned.preview.notebook.secrets).toEqual({ found: 1, kinds: ["google-api-key"] })
    expect(JSON.stringify(planned.preview)).not.toContain(secret)
  })

  it("uses a named template's machine, and refuses machine or accelerator beside a template", async () => {
    const { directory, path } = workspace()
    const { runner, vertex } = setup(OPTIONS, directory)
    vertex.templates = [{ name: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", machineSpec: { machineType: "e2-standard-4" } }]
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, template: "tpl-1" } }, call(), runner)) as { plan: unknown; preview: Record<string, any> }
    expect(planned.preview.compute).toMatchObject({ source: "template", machine: "e2-standard-4", template: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1" })
    await runTool("write", { plan: planned.plan }, call(), runner)
    expect(vertex.jobBodies[0]!.body).toMatchObject({ notebookRuntimeTemplateResourceName: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1" })
    expect(vertex.jobBodies[0]!.body.customEnvironmentSpec).toBeUndefined()
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, template: "tpl-1", machine: "e2-standard-4" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, template: "missing" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("reads a GCS notebook for the preview and sends gcsNotebookSource", async () => {
    const { directory } = workspace()
    const { runner, vertex, gcs } = setup(OPTIONS, directory)
    gcs.put("gs://inputs/notebooks/daily.ipynb", new Uint8Array(Buffer.from(JSON.stringify(notebook()))))
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { gcs: "gs://inputs/notebooks/daily.ipynb" } } }, call(), runner)) as { plan: unknown; preview: Record<string, any> }
    expect(planned.preview.notebook).toMatchObject({ source: "gcs", ref: "gs://inputs/notebooks/daily.ipynb", cells: 1 })
    await runTool("write", { plan: planned.plan }, call(), runner)
    expect(vertex.jobBodies[0]!.body).toMatchObject({ gcsNotebookSource: { uri: "gs://inputs/notebooks/daily.ipynb" } })
    expect(vertex.jobBodies[0]!.body.directNotebookSource).toBeUndefined()
  })

  it("refuses a notebook that is not nbformat 4, and a timeout over jobTimeoutMinutes", async () => {
    const { directory } = workspace("not a notebook", "bad.ipynb")
    const { runner } = setup(OPTIONS, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path: "bad.ipynb" } } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    const good = workspace()
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path: good.path }, timeoutMinutes: 120 } }, call(), setup(OPTIONS, good.directory).runner)).toMatchObject({ error: "INPUT_INVALID", message: expect.stringContaining("jobTimeoutMinutes") })
  })

  it("answers PLAN_CHANGED when the notebook changed between the preview and the commit", async () => {
    const { directory, path } = workspace()
    const { runner } = setup(OPTIONS, directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { plan: unknown }
    writeFileSync(path, JSON.stringify(notebook([{ cell_type: "code", id: "code-1", metadata: {}, execution_count: null, outputs: [], source: ["print('changed')"] }])))
    expect(await runTool("write", { plan: planned.plan }, call(), runner)).toMatchObject({ state: "refused", error: "PLAN_INVALID", next: "Plan again and show the new preview." })
  })
})

describe("colab_jobs", () => {
  it("lists jobs newest first with compute, schedule and error, filtered by state and limit", async () => {
    const { runner, vertex } = setup()
    vertex.putJob({ name: "projects/proj/locations/us-central1/notebookExecutionJobs/old", displayName: "old", state: "JOB_STATE_SUCCEEDED", createTime: "2026-11-10T09:00:00Z", updateTime: "2026-11-10T10:00:00Z", gcsOutputUri: "gs://results" })
    vertex.putJob({ name: "projects/proj/locations/us-central1/notebookExecutionJobs/new", displayName: "new", state: "JOB_STATE_FAILED", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:30:00Z", schedule: "projects/proj/locations/us-central1/schedules/7", machineType: "e2-standard-4", acceleratorType: "NVIDIA_TESLA_T4", error: "boom" })
    const listed = (await runTool("jobs", { account: "work" }, call(), runner)) as { state: string; jobs: Record<string, unknown>[]; trust: string }
    expect(listed.state).toBe("ok")
    expect(listed.trust).toBe("untrusted")
    expect(listed.jobs.map((job) => job.id)).toEqual(["new", "old"])
    expect(listed.jobs[0]).toMatchObject({ id: "new", displayName: "new", state: "JOB_STATE_FAILED", created: "2026-11-17T09:00:00Z", ended: "2026-11-17T09:30:00Z", compute: "e2-standard-4 + T4", schedule: "7", error: "boom" })
    expect(listed.jobs[1]).toMatchObject({ id: "old", state: "JOB_STATE_SUCCEEDED", ended: "2026-11-10T10:00:00Z" })
    const failed = (await runTool("jobs", { account: "work", state: "JOB_STATE_FAILED" }, call(), runner)) as { jobs: unknown[] }
    expect(failed.jobs).toHaveLength(1)
    const since = (await runTool("jobs", { account: "work", since: "2026-11-15T00:00:00Z" }, call(), runner)) as { jobs: unknown[] }
    expect(since.jobs).toHaveLength(1)
    expect(await runTool("jobs", { account: "work", since: "not-a-date" }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await runTool("jobs", { account: "work", limit: 1 }, call(), runner)).toMatchObject({ jobs: [{ id: "new" }] })
  })
})

describe("colab_jobs and retention (L13)", () => {
  it("asks the API each time and keeps no local history of finished jobs", async () => {
    const { runner, vertex, fakes } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-retained"
    vertex.putJob({ name, displayName: "old", state: "JOB_STATE_SUCCEEDED", createTime: "2026-11-01T09:00:00Z", updateTime: "2026-11-01T09:30:00Z" })
    expect(((await runTool("jobs", { account: "work" }, call(), runner)) as { jobs: unknown[] }).jobs).toHaveLength(1)
    // The API's retention window is Google's, and L13 measures it: the plugin holds no copy, so what the API stops
    // returning is gone from colab_jobs, and a read writes nothing to the ledger.
    vertex.jobs.delete(name)
    expect(((await runTool("jobs", { account: "work" }, call(), runner)) as { jobs: unknown[] }).jobs).toEqual([])
    expect(fakes.ledger.runs.size).toBe(0)
  })
})

describe("job.delete", () => {
  it("previews the record and what deleting keeps, then deletes it", async () => {
    const { runner, vertex } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-1"
    vertex.putJob({ name, displayName: "done", state: "JOB_STATE_SUCCEEDED", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:30:00Z", gcsOutputUri: "gs://results" })
    const planned = (await runTool("plan", { action: "job.delete", account: "work", params: { job: "oc-job-1" } }, call(), runner)) as { preview: Record<string, unknown>; plan: unknown; category: string; commit: string }
    expect(planned).toMatchObject({ category: "delete", commit: "colab_delete" })
    expect(planned.preview).toMatchObject({ action: "job.delete", job: { id: "oc-job-1", state: "JOB_STATE_SUCCEEDED" }, deletes: "the job record", keeps: expect.stringContaining("bucket") })
    expect(await runTool("delete", { plan: planned.plan }, call(), runner)).toMatchObject({ state: "ok", result: { id: "oc-job-1", deleted: true } })
    expect(vertex.jobs.size).toBe(0)
    expect(await runTool("plan", { action: "job.delete", account: "work", params: { job: "oc-job-1" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("says that deleting a running job may not stop it, until L11 records it", async () => {
    const { runner, vertex } = setup()
    const name = "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-running"
    vertex.putJob({ name, displayName: "running", state: "JOB_STATE_RUNNING", createTime: "2026-11-17T09:00:00Z", updateTime: "2026-11-17T09:00:00Z" })
    const planned = (await runTool("plan", { action: "job.delete", account: "work", params: { job: "oc-job-running" } }, call(), runner)) as { preview: Record<string, any> }
    expect(planned.preview.note).toContain("unverified")
    expect(planned.preview.note).toContain("colab_cancel")
  })
})


describe("paths through a symlinked directory (macOS's temp dir)", () => {
  it.skipIf(process.platform === "win32")("resolves a project that is itself behind a symlink", async () => {
    const real = mkdtempSync(join(tmpdir(), "colab-enterprise-real-"))
    const holder = mkdtempSync(join(tmpdir(), "colab-enterprise-link-"))
    directories.push(real, holder)
    const link = join(holder, "project")
    symlinkSync(real, link, "dir")
    const path = join(link, "analysis.ipynb")
    writeFileSync(path, JSON.stringify(notebook()))
    const { runner } = setup(OPTIONS, link)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { state: string; preview: Record<string, any> }
    expect(planned).toMatchObject({ state: "ok", preview: { notebook: { source: "path", ref: "analysis.ipynb" } } })
  })

  it.skipIf(process.platform === "win32")("still refuses a symlink inside the project, and one that escapes it", async () => {
    const real = mkdtempSync(join(tmpdir(), "colab-enterprise-inside-"))
    directories.push(real)
    writeFileSync(join(real, "analysis.ipynb"), JSON.stringify(notebook()))
    symlinkSync(join(real, "analysis.ipynb"), join(real, "alias.ipynb"), "file")
    symlinkSync(tmpdir(), join(real, "outside"), "dir")
    const { runner } = setup(OPTIONS, real)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path: join(real, "alias.ipynb") } } }, call(), runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path: join(real, "outside", "anything.ipynb") } } }, call(), runner)).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
  })
})
