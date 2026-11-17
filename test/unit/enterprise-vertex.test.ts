/**
 * Package E's Vertex AI and Cloud Storage clients over a fake `fetch`: the request shapes Google documents (v1 discovery
 * revision 20261107; Cloud Storage JSON API v1, fetched 2026-11-17), the error envelope mapped to the plugin's codes,
 * retries on reads only, and the fields the port does not carry (`machineType`, `executionTimeoutSeconds`, the schedule's
 * job request, idle shutdown, EUC). No network: every answer is a recorded shape.
 */
import { describe, expect, it } from "vitest"
import { createGcs } from "../../src/enterprise/gcs.js"
import { createVertex } from "../../src/enterprise/vertex.js"
import { fakeDeps } from "../fakes/index.js"

const OPTIONS = { accounts: { work: { backend: "enterprise" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }
const CLOUD = "https://www.googleapis.com/auth/cloud-platform"

function scripted(responses: { status: number; body?: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; method: string; body?: unknown }[] = []
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}) })
    const next = responses.shift()
    if (!next) throw new Error("the test ran out of scripted responses")
    return new Response(next.status === 204 || next.body === undefined ? null : JSON.stringify(next.body), { status: next.status, headers: next.headers ?? {} })
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

function env(fetchImpl: typeof fetch) {
  const { deps, fakes } = fakeDeps({ options: OPTIONS })
  fakes.auth.grants.set("work", [CLOUD])
  return { deps, fakes, base: { options: deps.options, directory: deps.directory, clock: deps.clock, auth: fakes.auth, ledger: fakes.ledger, fetch: fetchImpl } }
}

const JOB = {
  name: "projects/proj/locations/us-central1/notebookExecutionJobs/oc-job-1",
  displayName: "run",
  jobState: "JOB_STATE_SUCCEEDED",
  createTime: "2026-11-17T09:00:00Z",
  updateTime: "2026-11-17T09:30:00Z",
  gcsOutputUri: "gs://results",
  scheduleResourceName: "projects/proj/locations/us-central1/schedules/7",
  executionTimeout: "3600s",
  customEnvironmentSpec: { machineSpec: { machineType: "e2-standard-4", acceleratorType: "NVIDIA_TESLA_T4", acceleratorCount: 1 } },
  status: { message: "done" },
}

describe("the Vertex client", () => {
  it("creates a job with the documented URL, query, body and bearer token", async () => {
    const { fetch: fetchImpl, calls } = scripted([{ status: 200, body: { name: "projects/proj/locations/us-central1/operations/op-1", response: JOB } }])
    const vertex = createVertex(env(fetchImpl).base, { retryDelayMs: 0 })
    const created = await vertex.createJob("work", { jobId: "oc-job-1", body: { displayName: "run", gcsOutputUri: "gs://results" } }, new AbortController().signal)
    expect(created.job).toMatchObject({ name: JOB.name, state: "JOB_STATE_SUCCEEDED", endTime: "2026-11-17T09:30:00Z", machineType: "e2-standard-4", acceleratorType: "NVIDIA_TESLA_T4", executionTimeoutSeconds: 3600, schedule: "projects/proj/locations/us-central1/schedules/7" })
    expect(created.operation).toBe("projects/proj/locations/us-central1/operations/op-1")
    expect(calls[0]).toEqual({
      url: "https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/notebookExecutionJobs?notebookExecutionJobId=oc-job-1",
      method: "POST",
      body: { displayName: "run", gcsOutputUri: "gs://results" },
    })
    expect(calls[0]!.url).not.toContain("oc-job-1&")
  })

  it("lists jobs and maps the resource to the port, and answers undefined for a missing one", async () => {
    const { fetch: fetchImpl, calls } = scripted([{ status: 200, body: { notebookExecutionJobs: [JOB] } }, { status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "gone" } } }])
    const vertex = createVertex(env(fetchImpl).base, { retryDelayMs: 0 })
    const jobs = await vertex.listJobs("work", { pageSize: 10 }, new AbortController().signal)
    expect(jobs[0]).toMatchObject({ name: JOB.name, displayName: "run", state: "JOB_STATE_SUCCEEDED", gcsOutputUri: "gs://results", error: "done" })
    expect(calls[0]!.url).toContain("pageSize=10")
    expect(await vertex.getJob("work", "oc-job-missing", new AbortController().signal)).toBeUndefined()
  })

  it("creates, patches, pauses and resumes a schedule with Google's fields", async () => {
    const SCHEDULE = {
      name: "projects/proj/locations/us-central1/schedules/1",
      displayName: "nightly [oc-abcd1234]",
      cron: "TZ=America/New_York 0 9 * * *",
      state: "ACTIVE",
      maxRunCount: "30",
      startedRunCount: "2",
      endTime: "2026-12-31T00:00:00Z",
      createNotebookExecutionJobRequest: { parent: "projects/proj/locations/us-central1", notebookExecutionJob: { executionTimeout: "3600s" } },
    }
    const { fetch: fetchImpl, calls } = scripted([{ status: 200, body: SCHEDULE }, { status: 200, body: { ...SCHEDULE, maxRunCount: "8" } }, { status: 200, body: {} }, { status: 200, body: {} }, { status: 204 }])
    const vertex = createVertex(env(fetchImpl).base, { retryDelayMs: 0 })
    const created = await vertex.createSchedule("work", { displayName: SCHEDULE.displayName, cron: SCHEDULE.cron }, new AbortController().signal)
    expect(created).toMatchObject({ name: SCHEDULE.name, maxRunCount: 30, startedRunCount: 2, jobRequest: { parent: "projects/proj/locations/us-central1" } })
    expect(calls[0]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/schedules")
    await vertex.updateSchedule("work", "1", { updateMask: "cron,maxRunCount", cron: "0 9 * * *", maxRunCount: "8" }, new AbortController().signal)
    expect(calls[1]!.method).toBe("PATCH")
    expect(calls[1]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/schedules/1?updateMask=cron%2CmaxRunCount")
    expect(calls[1]!.body).toEqual({ cron: "0 9 * * *", maxRunCount: "8" })
    await vertex.pauseSchedule("work", "1", new AbortController().signal)
    await vertex.resumeSchedule("work", "1", new AbortController().signal)
    await vertex.deleteSchedule("work", "1", new AbortController().signal)
    expect(calls.slice(2).map((entry) => [entry.method, entry.url])).toEqual([
      ["POST", "https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/schedules/1:pause"],
      ["POST", "https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/schedules/1:resume"],
      ["DELETE", "https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/schedules/1"],
    ])
  })

  it("cancels the create LRO, and reads runtimes, their idle shutdown and EUC, and templates", async () => {
    const { fetch: fetchImpl, calls } = scripted([
      { status: 200, body: {} },
      {
        status: 200,
        body: {
          notebookRuntimes: [
            { name: "projects/proj/locations/us-central1/notebookRuntimes/rt-1", runtimeState: "RUNNING", machineSpec: { machineType: "n1-standard-4", acceleratorType: "NVIDIA_TESLA_T4" }, idleShutdownConfig: { idleTimeout: "10800s" }, eucConfig: { eucDisabled: false }, notebookRuntimeTemplateRef: { notebookRuntimeTemplate: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1" } },
            { name: "projects/proj/locations/us-central1/notebookRuntimes/rt-2", runtimeState: "STOPPED", idleShutdownConfig: { idleShutdownDisabled: true }, eucConfig: { eucDisabled: true } },
          ],
        },
      },
      { status: 200, body: { notebookRuntimeTemplates: [{ name: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", machineSpec: { machineType: "e2-standard-4" } }] } },
      { status: 200, body: {} },
    ])
    const vertex = createVertex(env(fetchImpl).base, { retryDelayMs: 0 })
    await vertex.cancelOperation("work", "projects/proj/locations/us-central1/operations/op-1", new AbortController().signal)
    expect(calls[0]!.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/operations/op-1:cancel")
    const runtimes = await vertex.listRuntimes("work", new AbortController().signal)
    expect(runtimes[0]).toMatchObject({ name: "projects/proj/locations/us-central1/notebookRuntimes/rt-1", state: "RUNNING", machineType: "n1-standard-4", accelerator: "NVIDIA_TESLA_T4", template: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", idleShutdownMinutes: 180, euc: true })
    expect(runtimes[1]).toMatchObject({ idleShutdownMinutes: null, euc: false })
    const templates = await vertex.listTemplates("work", new AbortController().signal)
    expect(templates[0]).toMatchObject({ name: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1" })
    await vertex.stopRuntime("work", "rt-1", new AbortController().signal)
    expect(calls.at(-1)!.url).toBe("https://aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/notebookRuntimes/rt-1:stop")
  })

  it("maps Google's error envelope: a disabled API, permission, not found, quota with its retry delay, and 5xx after retries", async () => {
    const disabled = scripted([{ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "aiplatform.googleapis.com is not enabled", details: [{ reason: "SERVICE_DISABLED" }] } } }])
    await expect(createVertex(env(disabled.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "API_DISABLED" })
    const denied = scripted([{ status: 403, body: { error: { code: 403, status: "PERMISSION_DENIED", message: "no", details: [{ reason: "IAM_PERMISSION_DENIED" }] } } }])
    await expect(createVertex(env(denied.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    const missing = scripted([{ status: 404, body: { error: { code: 404, status: "NOT_FOUND", message: "gone" } } }])
    await expect(createVertex(env(missing.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "NOT_FOUND" })
    const quota = scripted([
      { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ reason: "RATE_LIMIT_EXCEEDED", retryDelay: "30s" }] } } },
      { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ reason: "RATE_LIMIT_EXCEEDED", retryDelay: "30s" }] } } },
      { status: 429, body: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota", details: [{ reason: "RATE_LIMIT_EXCEEDED", retryDelay: "30s" }] } } },
    ])
    await expect(createVertex(env(quota.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "RATE_LIMITED", retryAfterSec: 30 })
    expect(quota.calls).toHaveLength(3)
    const down = scripted([
      { status: 500, body: { error: { code: 500, message: "boom" } } },
      { status: 500, body: { error: { code: 500, message: "boom" } } },
      { status: 500, body: { error: { code: 500, message: "boom" } } },
    ])
    await expect(createVertex(env(down.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(down.calls).toHaveLength(3)
    const unauthorised = scripted([{ status: 401, body: { error: { code: 401, status: "UNAUTHENTICATED", message: "sign in" } } }])
    await expect(createVertex(env(unauthorised.fetch).base, { retryDelayMs: 0 }).listTemplates("work", new AbortController().signal)).rejects.toMatchObject({ code: "AUTH_REQUIRED" })
  })
})

describe("the Cloud Storage client", () => {
  it("lists a prefix across pages and reads an object with its name encoded", async () => {
    const { fetch: fetchImpl, calls } = scripted([
      { status: 200, body: { items: [{ name: "runs/a.ipynb", size: 12, updated: "2026-11-17T09:10:00Z" }], nextPageToken: "page-2" } },
      { status: 200, body: { items: [{ name: "runs/b.ipynb", size: 34 }] } },
      { status: 200, body: undefined },
    ])
    const gcs = createGcs(env(fetchImpl).base, { retryDelayMs: 0 })
    const listed = await gcs.list("work", "gs://results/runs/", new AbortController().signal)
    expect(listed).toEqual([
      { uri: "gs://results/runs/a.ipynb", size: 12, updated: "2026-11-17T09:10:00Z" },
      { uri: "gs://results/runs/b.ipynb", size: 34 },
    ])
    expect(calls[0]!.url).toContain("/b/results/o?")
    expect(calls[0]!.url).toContain("prefix=runs%2F")
    expect(calls[1]!.url).toContain("pageToken=page-2")
    const bytes = await gcs.read("work", "gs://results/runs/a.ipynb", new AbortController().signal)
    expect(bytes).toEqual(new Uint8Array())
    expect(calls[2]!.url).toBe("https://storage.googleapis.com/storage/v1/b/results/o/runs%2Fa.ipynb?alt=media")
  })

  it("maps a missing object to NOT_FOUND and refuses a bucket as an object", async () => {
    const { fetch: fetchImpl } = scripted([{ status: 404, body: { error: { code: 404, message: "no such object" } } }])
    const gcs = createGcs(env(fetchImpl).base, { retryDelayMs: 0 })
    await expect(gcs.read("work", "gs://results/missing.csv", new AbortController().signal)).rejects.toMatchObject({ code: "NOT_FOUND" })
    await expect(gcs.read("work", "gs://results", new AbortController().signal)).rejects.toMatchObject({ code: "INPUT_INVALID" })
  })
})
