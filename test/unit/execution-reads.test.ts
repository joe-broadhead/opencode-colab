// Package D's read tests (design §6): colab_specs, colab_runtimes, colab_files and the Enterprise branch of
// colab_execution. Each read asserts colab.<tool> on the account and colab.read on each provider operation before the
// call; a denied read leaves the fakes' logs empty.
import { afterEach, describe, expect, it } from "vitest"
import { OPERATIONS } from "../../src/domain/actions.js"
import { prepared, RecordingPermission, runtimeRecord, tool, toolWith } from "../fakes/execution-harness.js"

const dirs: string[] = []
afterEach(async () => {
  const { rm } = await import("node:fs/promises")
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

const preparedIn = async (input: Parameters<typeof prepared>[0] = {}) => {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const directory = await mkdtemp(join(tmpdir(), "colab-reads-"))
  dirs.push(directory)
  return prepared({ ...input, directory })
}

describe("colab_specs", () => {
  it("shows consumer specs with the eligibility and accelerator verdicts, and the tier", async () => {
    const { deps, fakes } = await preparedIn()
    fakes.colab.tier = "SUBSCRIPTION_TIER_FREE"
    const { result, permission } = tool(deps, "specs", {})
    const answer = (await result) as { state: string; tier: string; specs: { key?: { accelerator: string }; eligible?: boolean; allowed: boolean; verdict: string }[]; warnings?: string[] }
    expect(answer.state).toBe("ok")
    expect(answer.tier).toBe("SUBSCRIPTION_TIER_FREE")
    expect(answer.specs.map((entry) => [entry.key?.accelerator, entry.eligible, entry.allowed])).toEqual([
      ["NONE", true, true],
      ["T4", true, true],
    ])
    expect(answer.warnings).toContain("FREE_TIER_PRIORITY")
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.specs", ["default"]],
      ["colab.read", [`default:${OPERATIONS.runtimeSpecsList}`]],
      ["colab.read", [`default:${OPERATIONS.subscriptionGet}`]],
    ])
  })

  it("marks a spec outside the accelerator allow-list as not allowed", async () => {
    const { deps, fakes } = await preparedIn({ options: { accelerators: ["NONE"] } })
    fakes.colab.specs = [...fakes.colab.specs, { key: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "A100" }, eligible: true }]
    const answer = (await tool(deps, "specs", {}).result) as { specs: { allowed: boolean; verdict: string }[] }
    expect(answer.specs.at(-1)).toMatchObject({ allowed: false })
    expect(answer.specs.at(-1)!.verdict).toContain("not in accelerators")
  })

  it("shows Enterprise templates and the bundled machine rate, and says when nothing is priced", async () => {
    const { deps, fakes } = await preparedIn({ options: { accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1", outputBucket: "gs://b" } } } })
    fakes.vertex.templates = [{ name: "projects/p/locations/l/notebookRuntimeTemplates/t1", machineType: "e2-standard-4", acceleratorType: "NONE" }]
    const answer = (await tool(deps, "specs", { account: "work" }).result) as { state: string; pricesAsOf: string; specs: { template?: string; usdPerHour?: number; verdict: string }[] }
    expect(answer.state).toBe("ok")
    expect(answer.pricesAsOf).toBe("2026-11-17")
    expect(answer.specs[0]!.usdPerHour).toBe(0.19)
    expect(answer.specs[1]).toMatchObject({ template: "projects/p/locations/l/notebookRuntimeTemplates/t1", usdPerHour: 0.19 })
    Object.assign(deps, { prices: { asOf: "", source: "", region: "us-central1", usdPerHour: () => undefined } })
    const unpriced = (await tool(deps, "specs", { account: "work" }).result) as { warnings?: string[]; specs: { verdict: string }[] }
    expect(unpriced.warnings).toContain("RATES_UNKNOWN")
    expect(unpriced.specs[0]!.verdict).toContain("ESTIMATE_UNKNOWN")
  })

  it("runs no read when the ask is denied", async () => {
    const { deps, fakes } = await preparedIn()
    const permission = new RecordingPermission()
    permission.denyAll()
    await expect(toolWith(deps, permission, "specs", {}).result).rejects.toThrow(/denied/)
    expect(fakes.colab.calls).toHaveLength(0)
  })
})

describe("colab_runtimes", () => {
  it("lists the plugin's own first, with taint, idle, lease and keep, then the account's other runtimes", async () => {
    const { deps, fakes, record, runtime } = await preparedIn()
    fakes.colab.runtimes.set("someone-elses", { name: "runtimes/someone-elses", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } })
    runtime.kernels_.set(record.id, [{ id: "k1", name: "python3", executionState: "idle", lastActivity: "2026-11-17T08:50:00.000Z", connections: 0 }])
    const answer = (await tool(deps, "runtimes", {}).result) as { runtimes: { id: string; ours: boolean; idleSince?: string; lease?: unknown; keep?: string[]; spec: string }[] }
    expect(answer.runtimes.map((runtime) => [runtime.id, runtime.ours])).toEqual([
      [record.id, true],
      ["someone-elses", false],
    ])
    expect(answer.runtimes[0]).toMatchObject({ spec: "T4/standard", idleSince: "2026-11-17T08:50:00.000Z", keep: ["/content/outputs/**"], lease: { releaseAfterIdleMinutes: 20, maxHours: 4 } })
  })

  it("marks a tainted runtime and refuses a runtime id that does not exist", async () => {
    const { deps } = await preparedIn({ record: runtimeRecord({ tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: "2026-11-17T09:00:00.000Z" } }) })
    const answer = (await tool(deps, "runtimes", {}).result) as { runtimes: { tainted: boolean }[] }
    expect(answer.runtimes[0]!.tainted).toBe(true)
    expect(await tool(deps, "runtimes", { runtime: "oc-nope" }).result).toMatchObject({ state: "refused", error: "NOT_FOUND" })
  })

  it("lists Enterprise runtimes with $/h and the idle-shutdown and EUC flags", async () => {
    const { deps, fakes } = await preparedIn({ options: { accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1", outputBucket: "gs://b" } } } })
    fakes.vertex.runtimes.set("projects/p/locations/l/notebookRuntimes/r1", { name: "projects/p/locations/l/notebookRuntimes/r1", state: "RUNNING", machineType: "e2-standard-4", accelerator: "NONE", idleShutdownMinutes: 180, euc: true })
    const answer = (await tool(deps, "runtimes", { account: "work" }).result) as { runtimes: { id: string; usdPerHour?: number; idleShutdownMinutes?: number | null; euc?: boolean }[] }
    expect(answer.runtimes[0]).toMatchObject({ usdPerHour: 0.19, idleShutdownMinutes: 180, euc: true })
  })
})

describe("colab_files", () => {
  it("lists a runtime folder, marks files outside keep, and asserts colab.read on contents.list", async () => {
    const { deps, record, runtime } = await preparedIn()
    runtime.contents.set(record.id, new Map([
      ["/content/outputs/kept.csv", Buffer.from("x")],
      ["/content/scratch.bin", Buffer.from("y")],
    ]))
    const { result, permission } = tool(deps, "files", { runtime: record.id })
    const answer = (await result) as { files: { path: string; kept: boolean; bytes?: number }[] }
    expect(answer.files.map((file) => [file.path, file.kept])).toEqual([
      ["/content/outputs/kept.csv", true],
      ["/content/scratch.bin", false],
    ])
    expect(permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.files", ["default"]],
      ["colab.read", [`default:${OPERATIONS.contentsList}`]],
    ])
  })

  it("refuses a runtime that is not the plugin's own before any request", async () => {
    const { deps, runtime } = await preparedIn()
    expect(await tool(deps, "files", { runtime: "oc-nope" }).result).toMatchObject({ error: "RUNTIME_NOT_OURS" })
    expect(runtime.calls).toHaveLength(0)
  })
})

describe("colab_execution", () => {
  it("answers the Enterprise branch through the seam, which asserts colab.read before its reads", async () => {
    const { deps, fakes } = await preparedIn({ options: { accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1", outputBucket: "gs://b" } } } })
    const { result, permission } = tool(deps, "execution", { account: "work", job: "projects/p/locations/l/notebookExecutionJobs/j1" })
    expect(await result).toMatchObject({ state: "ok" })
    expect(fakes.enterprise.calls).toHaveLength(1)
    expect(permission.requests.map((request) => [request.action, request.resources])).toContainEqual(["colab.read", [`work:${OPERATIONS.jobsGet}`]])
  })

  it("refuses a run that is not in the ledger or belongs to another account", async () => {
    const { deps } = await preparedIn()
    expect(await tool(deps, "execution", { runId: "01jmissing" }).result).toMatchObject({ state: "refused", error: "NOT_FOUND" })
  })
})
