// The one release function (design §8.3 step 2, §16 F): harvest the keep paths into `<workDir>/harvest/<runtimeId>/`,
// then `runtimes.delete`; a failed harvest blocks an automatic release; a tainted runtime is released only by plan; a
// run of ours active is RUNTIME_BUSY unless force; another live OpenCode process's lease is respected; and the ledger
// closes as released or gone. The strict end of the suite runs against package B's loopback Colab API and Jupyter fake.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createRelease, foreignLeaseHolder, harvestRuntime, closeRecord } from "../../src/cost/release.js"
import type { PortEnv } from "../../src/deps.js"
import { ColabError } from "../../src/domain/errors.js"
import { loadOptions } from "../../src/options.js"
import type { ColabApi, RuntimeRecord, RuntimeProtocol } from "../../src/ports.js"
import type { RuntimePorts } from "../../src/runtime/index.js"
import { FakeAgentOnlyCheck, FakeClock, FakeColabApi, MemoryLedger, T4 } from "../fakes/index.js"
import { CostContents, CostRuntime } from "../fakes/cost-fakes.js"
import { createRuntimeFixture } from "../fakes/runtime-env.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const temporary: string[] = []

const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "colab-cost-release-"))
  temporary.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ID = "oc-01jcostrelease000000000"

const record = (overrides: Partial<RuntimeRecord> = {}): RuntimeRecord => ({
  id: ID,
  account: "default",
  backend: "colab",
  spec: T4,
  createdAt: "2026-11-17T10:00:00.000Z",
  nonce: "n1",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
  ...overrides,
})

function environment(input: { directory?: string } = {}) {
  const clock = new FakeClock(NOW)
  const options = loadOptions({})
  const ledger = new MemoryLedger(clock)
  const colab = new FakeColabApi()
  const tree = new CostContents()
  const runtime = new CostRuntime(tree)
  const env: PortEnv = { options, directory: input.directory ?? tempDir(), clock, auth: { token: async () => "token", identity: async () => undefined, scopes: async () => [] }, ledger, fetch: (() => Promise.reject(new Error("no network in this test"))) as unknown as typeof fetch }
  const ports: RuntimePorts = { colab, runtime, check: new FakeAgentOnlyCheck() }
  const own = async (overrides: Partial<RuntimeRecord> = {}) => {
    const full = record(overrides)
    await ledger.putRuntime(full)
    colab.runtimes.set(full.id, { name: `runtimes/${full.id}`, spec: full.spec })
    return full
  }
  return { env, ports, ledger, colab, tree, release: createRelease(env, ports), own }
}

describe("harvest then release", () => {
  it("downloads every keep path into the harvest folder, then deletes the runtime and closes the ledger record", async () => {
    const world = environment()
    await world.own()
    world.tree.put("/content/outputs/report.csv", "cell,value\n1,2\n")
    world.tree.put("/content/outputs/plots/loss.png", "png-bytes")

    const answer = await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)

    expect(answer.released).toBe(true)
    expect(answer.warnings).toEqual([])
    expect([...answer.harvested].sort()).toEqual(["/content/outputs/plots/loss.png", "/content/outputs/report.csv"])
    const harvest = join(world.env.directory, ".colab", "harvest", ID)
    expect(readFileSync(join(harvest, "content", "outputs", "report.csv"), "utf8")).toBe("cell,value\n1,2\n")
    expect(readFileSync(join(harvest, "content", "outputs", "plots", "loss.png"), "utf8")).toBe("png-bytes")
    expect([...world.colab.runtimes.keys()]).toEqual([])
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toHaveLength(1)
    const closed = await world.ledger.getRuntime(ID)
    expect(closed).toMatchObject({ state: "released", releasedAt: NOW.toISOString() })
    expect(world.ledger.events.at(-1)).toMatchObject({ type: "runtime.released", id: ID })
  })

  it("leaves an empty harvest as no work, not a failure", async () => {
    const world = environment()
    await world.own()
    const answer = await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)
    expect(answer).toMatchObject({ released: true, harvested: [] })
  })

  it("blocks an automatic release when the harvest fails, and releases nothing", async () => {
    const world = environment()
    await world.own()
    world.tree.put("/content/outputs/report.csv", "data")
    world.tree.failing.set("/content/outputs/report.csv", "UNAVAILABLE")

    const answer = await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)

    expect(answer).toEqual({ harvested: [], released: false, warnings: ["UNHARVESTED"] })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toEqual([])
    expect(await world.ledger.getRuntime(ID)).toMatchObject({ state: "ready" })
  })

  it("blocks a plan's release too when the harvest fails, and the result says UNHARVESTED", async () => {
    const world = environment()
    await world.own()
    world.tree.put("/content/outputs/report.csv", "data")
    world.tree.failing.set("/content/outputs/report.csv", "UNAVAILABLE")
    const answer = await world.release.release(record(), { reason: "plan", force: false }, new AbortController().signal)
    expect(answer).toEqual({ harvested: [], released: false, warnings: ["UNHARVESTED"] })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toEqual([])
    expect(await world.ledger.getRuntime(ID)).toMatchObject({ state: "ready" })
  })

  it("releases a runtime of ours with nothing to harvest when another process says it is gone", async () => {
    const world = environment()
    await world.own()
    world.colab.runtimes.delete(ID)
    const answer = await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)
    expect(answer).toEqual({ harvested: [], released: true, warnings: [] })
    expect(await world.ledger.getRuntime(ID)).toMatchObject({ state: "gone" })
    expect(world.ledger.events.at(-1)).toMatchObject({ type: "runtime.gone" })
  })

  it("is idempotent: a released record is not deleted twice", async () => {
    const world = environment()
    await world.own()
    const first = await world.release.release(record(), { reason: "plan", force: false }, new AbortController().signal)
    const second = await world.release.release(record(), { reason: "plan", force: false }, new AbortController().signal)
    expect(first.released).toBe(true)
    expect(second).toEqual({ harvested: [], released: false, warnings: [] })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toHaveLength(1)
  })
})

describe("the guards", () => {
  it("never releases a run's runtime automatically, and refuses a plan unless it forces", async () => {
    const world = environment()
    await world.own()
    await world.ledger.putRun({ runId: "run-1", account: "default", backend: "colab", runtime: ID, startedAt: NOW.toISOString(), state: "running", cellIds: [], outputPaths: [] })

    expect(await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)).toEqual({ harvested: [], released: false, warnings: [] })
    await expect(world.release.release(record(), { reason: "plan", force: false }, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_BUSY" })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toEqual([])

    const forced = await world.release.release(record(), { reason: "plan", force: true }, new AbortController().signal)
    expect(forced.released).toBe(true)
  })

  it("never releases a tainted runtime automatically; a plan does, with UNHARVESTED, because the fence refuses every read", async () => {
    const world = environment()
    await world.own({ tainted: { code: "RUNTIME_HAS_CREDENTIALS", at: NOW.toISOString() } })
    world.tree.put("/content/outputs/report.csv", "data")

    expect(await world.release.release(record(), { reason: "idle", force: false }, new AbortController().signal)).toEqual({ harvested: [], released: false, warnings: [] })
    expect(world.tree.reads).toEqual([])

    const answer = await world.release.release(record(), { reason: "plan", force: false }, new AbortController().signal)
    expect(answer).toEqual({ harvested: [], released: true, warnings: ["UNHARVESTED"] })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toHaveLength(1)
  })

  it("refuses to release a runtime another live OpenCode process holds", async () => {
    const world = environment()
    const dir = tempDir()
    const { FileLedger } = await import("../../src/ledger/store.js")
    const ledger = new FileLedger(dir, { ledgerDays: 90, clock: world.env.clock })
    await ledger.putRuntime(record())
    world.colab.runtimes.set(ID, { name: `runtimes/${ID}`, spec: T4 })
    const release = createRelease({ ...world.env, ledger }, world.ports)
    const owners = join(dir, "owners")
    ;(await import("node:fs")).mkdirSync(owners, { recursive: true })
    writeFileSync(join(owners, `${ID}.json`), JSON.stringify({ pid: 1, at: Date.now(), sessions: {} }))

    expect(foreignLeaseHolder(ledger, ID)).toBe(1)
    expect(await release.release(record(), { reason: "idle", force: false }, new AbortController().signal)).toEqual({ harvested: [], released: false, warnings: [] })
    await expect(release.release(record(), { reason: "plan", force: false }, new AbortController().signal)).rejects.toMatchObject({ code: "RUNTIME_BUSY" })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toEqual([])

    // A stale lease (no heartbeat for two minutes) is claimable, as B's lease documents.
    writeFileSync(join(owners, `${ID}.json`), JSON.stringify({ pid: 1, at: Date.now() - 3 * 60_000, sessions: {} }))
    expect(foreignLeaseHolder(ledger, ID)).toBeUndefined()
    expect((await release.release(record(), { reason: "idle", force: false }, new AbortController().signal)).released).toBe(true)
  })

  it("a runtime that is not ours, or one already released, is never deleted", async () => {
    const world = environment()
    expect(await world.release.release(record({ state: "released", releasedAt: NOW.toISOString() }), { reason: "idle", force: false }, new AbortController().signal)).toEqual({ harvested: [], released: false, warnings: [] })
    expect(world.colab.calls.filter((call) => call.method === "deleteRuntime")).toEqual([])
  })
})

describe("the harvest itself", () => {
  const target = { account: "default", runtimeId: ID }
  const signal = () => new AbortController().signal

  it("refuses a path that could leave the harvest folder", async () => {
    const protocol = { files: { list: async () => [{ path: "/content/outputs/../../etc/passwd", type: "file" as const }] } } as unknown as Pick<RuntimeProtocol, "files">
    const answer = await harvestRuntime({ files: protocol, target, keep: ["/content/outputs/**"], harvestDir: join(tempDir(), "harvest"), maxBytes: 1024, signal: signal() })
    expect(answer).toEqual({ ok: false, files: [], reason: "PATH_REFUSED" })
  })

  it("blocks, rather than skips, when a keep tree holds more files than the harvest takes", async () => {
    const tree = new CostContents()
    for (let index = 0; index < 501; index++) tree.put(`/content/outputs/file-${index}.txt`, "x")
    const answer = await harvestRuntime({ files: new CostRuntime(tree), target, keep: ["/content/outputs/**"], harvestDir: join(tempDir(), "harvest"), maxBytes: 10 * 1024 * 1024, signal: signal() })
    expect(answer).toEqual({ ok: false, files: [], reason: "count" })
  })

  it("caps the harvest across files, not per file", async () => {
    const tree = new CostContents()
    tree.put("/content/outputs/one.txt", "123456")
    tree.put("/content/outputs/two.txt", "123456")
    const answer = await harvestRuntime({ files: new CostRuntime(tree), target, keep: ["/content/outputs/**"], harvestDir: join(tempDir(), "harvest"), maxBytes: 10, signal: signal() })
    expect(answer).toMatchObject({ ok: false, reason: "FILE_TOO_LARGE", files: ["/content/outputs/one.txt"] })
  })

  it("blocks when the keep files exceed maxDownloadBytes", async () => {
    const tree = new CostContents()
    tree.put("/content/outputs/one.bin", "0123456789")
    const answer = await harvestRuntime({ files: new CostRuntime(tree), target, keep: ["/content/outputs/**"], harvestDir: join(tempDir(), "harvest"), maxBytes: 4, signal: signal() })
    expect(answer).toMatchObject({ ok: false, reason: "FILE_TOO_LARGE" })
  })
})

describe("closeRecord", () => {
  it("writes the record and one event, and is the only place a record ends", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    const full = record()
    await ledger.putRuntime(full)
    const next = await closeRecord(ledger, full, "released", NOW.toISOString())
    expect(next).toMatchObject({ state: "released", releasedAt: NOW.toISOString() })
    expect(ledger.events).toEqual([expect.objectContaining({ type: "runtime.released", id: ID, account: "default" })])
  })
})

describe("against package B's fakes", () => {
  it("harvests through the real runtime protocol, over the loopback proxy, and deletes through the real Colab API client", async () => {
    const fixture = await createRuntimeFixture()
    const directory = tempDir()
    try {
      const record = await fixture.own()
      fixture.jupyter.contents.set("content/outputs/result.csv", new TextEncoder().encode("a,b\n"))
      const release = createRelease({ ...fixture.env, directory }, fixture.ports)
      const answer = await release.release(record, { reason: "plan", force: false }, fixture.signal())

      expect(answer.released).toBe(true)
      expect(answer.harvested).toEqual(["/content/outputs/result.csv"])
      expect(readFileSync(join(directory, ".colab", "harvest", record.id, "content", "outputs", "result.csv"), "utf8")).toBe("a,b\n")
      expect(fixture.api.runtimes.has(record.id)).toBe(false)
      expect((await fixture.ledger.getRuntime(record.id))?.state).toBe("released")
    } finally {
      await fixture.close()
    }
  })
})

/** The release seam's own shape: a ColabApi whose delete is failable, to prove a refusal is not a release. */
describe("a delete that fails", () => {
  it("keeps the record ready and rethrows, so the plan reports it", async () => {
    const world = environment()
    await world.own()
    const failing: Pick<ColabApi, "deleteRuntime" | "getRuntime"> = {
      deleteRuntime: async () => Promise.reject(new ColabError("UNAVAILABLE")),
      getRuntime: async () => undefined,
    }
    const release = createRelease(world.env, { ...world.ports, colab: failing as ColabApi })
    await expect(release.release(record(), { reason: "plan", force: false }, new AbortController().signal)).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(await world.ledger.getRuntime(ID)).toMatchObject({ state: "ready" })
  })
})
