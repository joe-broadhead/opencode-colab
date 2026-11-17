/**
 * Design §15.1 "Cost": Enterprise estimates against the dated price table (§8.1's worked examples as fixtures), the
 * cap and the ceiling, ESTIMATE_UNKNOWN and `rates`, schedule bounds and SCHEDULE_OVERLAP with CRON_TZ, and a
 * schedule's worst case per run and per month.
 *
 * Prices come from Google's Colab Enterprise pricing page (us-central1, on-demand, fetched 2026-11-17) and the
 * machine shapes from Compute Engine machine types; src/enterprise/prices.ts holds both citations.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import type { Deps } from "../../src/deps.js"
import { MACHINES, PRICES_AS_OF, priceOf } from "../../src/enterprise/prices.js"
import { parseCron } from "../../src/enterprise/cron.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { toolHandlers } from "../../src/tools/registry.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_enterprise", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const ENTERPRISE = {
  accounts: { work: { backend: "enterprise", project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } },
}

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function notebookAt(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "colab-enterprise-cost-"))
  directories.push(directory)
  const path = join(directory, "analysis.ipynb")
  writeFileSync(
    path,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", language: "python" } },
      cells: [
        { cell_type: "markdown", id: "md-1", metadata: {}, source: ["# Analysis"] },
        { cell_type: "code", id: "code-1", metadata: {}, execution_count: null, outputs: [], source: ["print('hi')"] },
      ],
    }),
  )
  return { directory, path }
}

function setup(options: unknown, directory?: string) {
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

describe("the dated price table", () => {
  it("reproduces design §8.1's worked examples with a 100 GB SSD disk", () => {
    const near = (machine: string, expected: number, accelerator?: string) => {
      const price = priceOf({ machine, ...(accelerator !== undefined ? { accelerator } : {}) })
      expect(price, machine).toBeDefined()
      expect(Math.abs(price!.usdPerHour - expected), `${machine} ${price!.usdPerHour}`).toBeLessThan(0.02)
    }
    near("e2-standard-4", 0.22)
    near("n1-standard-4", 0.79, "T4")
    near("g2-standard-8", 1.23)
    near("a2-highgpu-1g", 5.17)
    // An H100 alone, without a machine or disk: the accelerator column's two rates.
    expect(priceOf({ machine: "n1-standard-4", accelerator: "H100" })).toBeUndefined() // n1 cannot carry an H100
    const h100 = priceOf({ machine: "a3-highgpu-1g" })!
    expect(Math.abs(h100.acceleratorUsdPerHour - 13.72)).toBeLessThan(0.01)
  })

  it("prices the disk, the machine and the accelerator apart, and shows the date", () => {
    const price = priceOf({ machine: "e2-standard-4", diskGb: 100 })!
    expect(price.diskGb).toBe(100)
    expect(price.accelerator).toBeUndefined()
    expect(price.usdPerHour).toBeCloseTo(price.vCpuUsdPerHour + price.memoryUsdPerHour + price.diskUsdPerHour, 6)
    expect(PRICES_AS_OF).toBe("2026-11-17")
    expect(Object.keys(MACHINES)).toContain("e2-standard-4")
  })

  it("applies a rates override by machine and by accelerator, and refuses a machine it cannot price", () => {
    expect(priceOf({ machine: "n9-unknown" })).toBeUndefined()
    const overridden = priceOf({ machine: "n9-unknown", rates: { "n9-unknown": 1.5 } })!
    expect(overridden.usdPerHour).toBeCloseTo(1.5 + overridden.diskUsdPerHour, 6)
    const freeT4 = priceOf({ machine: "n1-standard-4", accelerator: "T4", rates: { T4: 0 } })!
    expect(freeT4.acceleratorUsdPerHour).toBe(0)
    expect(freeT4.overridden).toBe(true)
  })
})

describe("a job's estimate against the cap and the ceiling", () => {
  it("previews $/h, the worst case, the cap, the ceiling and the job id", async () => {
    const { directory, path } = notebookAt()
    const { runner } = setup(ENTERPRISE, directory)
    const planned = (await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path } } }, call(), runner)) as { preview: Record<string, any>; planId: string }
    expect(planned).toMatchObject({ state: "ok", action: "job.create", category: "write", commit: "colab_write" })
    expect(planned.preview).toMatchObject({
      action: "job.create",
      notebook: { source: "path", ref: path.replace(directory + "/", ""), cells: 2, secrets: { found: 0, kinds: [] } },
      compute: { source: "customEnvironmentSpec", machine: "e2-standard-4", accelerator: "NONE", usdPerHour: 0.22, diskGb: 100, pricesAsOf: "2026-11-17" },
      executionTimeout: { minutes: 60, seconds: 3600 },
      identity: { as: "serviceAccount", label: "runner@proj.iam.gserviceaccount.com" },
      outputBucket: "gs://results",
      cost: { usdPerHour: 0.22, maxComputeUsd: 0.22, capUsd: 5, ceilingUsd: 50, timeoutMinutes: 60 },
    })
    expect(planned.preview.jobId).toMatch(/^oc-job-[0-9a-z]{26}$/)
    expect(planned.preview.labels.oc_plugin).toBe("colab")
  })

  it("refuses an estimate over $5 on an A100, allows it under a higher maxUsd, and refuses a maxUsd over the $50 ceiling", async () => {
    const { directory, path } = notebookAt()
    const allowed = { ...ENTERPRISE, accelerators: ["NONE", "T4", "L4", "A100"] }
    const { runner } = setup(allowed, directory)
    const over = await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "a2-highgpu-1g" } }, call(), runner)
    expect(over).toMatchObject({ state: "refused", error: "COST_CAP", message: expect.stringContaining("5.18") })
    const raised = await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "a2-highgpu-1g", maxUsd: 10 } }, call(), runner)
    expect(raised).toMatchObject({ state: "ok", preview: { cost: { maxComputeUsd: 5.18, capUsd: 10 } } })
    const tooHigh = await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, maxUsd: 60 } }, call(), runner)
    expect(tooHigh).toMatchObject({ state: "refused", error: "COST_CAP", message: expect.stringContaining("maxJobUsdCeiling") })
  })

  it("refuses an accelerator outside the allow-list, including a machine's own GPU", async () => {
    const { directory, path } = notebookAt()
    const { runner } = setup(ENTERPRISE, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "n1-standard-4", accelerator: "T4" } }, call(), runner)).toMatchObject({ state: "ok" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "n1-standard-4", accelerator: "V100" } }, call(), runner)).toMatchObject({ error: "ACCELERATOR_NOT_ALLOWED" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "a2-highgpu-1g" } }, call(), runner)).toMatchObject({ error: "ACCELERATOR_NOT_ALLOWED" })
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "e2-standard-4", accelerator: "T4" } }, call(), runner)).toMatchObject({ error: "ESTIMATE_UNKNOWN" })
  })

  it("answers ESTIMATE_UNKNOWN for a machine the table does not price, unless rates names it", async () => {
    const { directory, path } = notebookAt()
    const plain = setup(ENTERPRISE, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "n9-unknown" } }, call(), plain.runner)).toMatchObject({ state: "refused", error: "ESTIMATE_UNKNOWN", message: expect.stringContaining("2026-11-17") })
    const priced = setup({ ...ENTERPRISE, rates: { "n9-unknown": 1.5 } }, directory)
    expect(await runTool("plan", { action: "job.create", account: "work", params: { notebook: { path }, machine: "n9-unknown" } }, call(), priced.runner)).toMatchObject({ state: "ok", preview: { compute: { machine: "n9-unknown" } } })
  })
})

describe("a schedule's bounds, overlap and worst case", () => {
  it("shows the next five runs, the minimum gap and the per-run and per-month worst case", async () => {
    const { directory, path } = notebookAt()
    const { runner } = setup(ENTERPRISE, directory)
    const planned = (await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "nightly", cron: "0 9 * * *", timeZone: "America/New_York", maxRunCount: 30 } }, call(), runner)) as { preview: Record<string, any> }
    expect(planned).toMatchObject({
      state: "ok",
      category: "write",
      preview: {
        cron: "TZ=America/New_York 0 9 * * *",
        timeZone: "America/New_York",
        bounds: { maxRunCount: 30 },
        requiredGapMinutes: 70,
        minimumGapMinutes: 1440,
        concurrency: { maxConcurrentRunCount: 1, allowQueueing: false },
        cost: { perRunUsd: 0.22, runsPerMonth: 30 },
      },
    })
    expect(planned.preview.nextRuns).toHaveLength(5)
    // 09:00 EST is 14:00 UTC; the next run after 2026-11-17T09:00Z is the same day.
    expect(planned.preview.nextRuns[0]).toBe("2026-11-17T14:00:00.000Z")
    expect(planned.preview.cost.perMonthUsd).toBeCloseTo(6.61, 2)
  })

  it("refuses a schedule with no bound, and one whose shortest gap is under the timeout plus the margin", async () => {
    const { directory, path } = notebookAt()
    const { runner } = setup(ENTERPRISE, directory)
    const unbounded = await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "forever", cron: "0 9 * * *" } }, call(), runner)
    expect(unbounded).toMatchObject({ state: "refused", error: "SCHEDULE_UNBOUNDED" })
    const overlap = await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "twice", cron: "0 9,10 * * *", maxRunCount: 10 } }, call(), runner)
    expect(overlap).toMatchObject({ state: "refused", error: "SCHEDULE_OVERLAP", message: expect.stringContaining("60 minutes") })
    // The same cron with a 30-minute timeout fits the 60-minute gap and the 10-minute margin.
    const fits = await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "twice", cron: "0 9,10 * * *", maxRunCount: 10, timeoutMinutes: 30 } }, call(), runner)
    expect(fits).toMatchObject({ state: "ok", preview: { minimumGapMinutes: 60, requiredGapMinutes: 40 } })
  })

  it("carries CRON_TZ through the preview and refuses a bad zone or a past endTime", async () => {
    const { directory, path } = notebookAt()
    const { runner } = setup(ENTERPRISE, directory)
    const prefixed = await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "tokyo", cron: "CRON_TZ=Asia/Tokyo 30 8 * * *", maxRunCount: 3 } }, call(), runner)
    expect(prefixed).toMatchObject({ state: "ok", preview: { cron: "TZ=Asia/Tokyo 30 8 * * *", timeZone: "Asia/Tokyo" } })
    expect(await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "bad", cron: "0 9 * * *", timeZone: "Mars/Olympus", maxRunCount: 2 } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
    expect(await runTool("plan", { action: "schedule.create", account: "work", params: { notebook: { path }, displayName: "past", cron: "0 9 * * *", endTime: "2020-01-01T00:00:00Z" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
  })
})

describe("cron arithmetic", () => {
  it("reads five fields with names, ranges, lists and steps", () => {
    expect(parseCron("0 9 * * 1-5").daysOfWeek).toEqual([1, 2, 3, 4, 5])
    expect(parseCron("*/15 9-17 * * MON-FRI").minutes).toEqual([0, 15, 30, 45])
    expect(parseCron("0 0 1 JAN,jul *").months).toEqual([1, 7])
    expect(parseCron("0 0 * * 7").daysOfWeek).toEqual([0])
  })
})
