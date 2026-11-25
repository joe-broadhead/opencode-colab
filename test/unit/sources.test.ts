import { describe, expect, test } from "vitest"
import { checkOutput } from "@we-the-rebel-alliance/plugin-contract/outputs"
import { RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { listRuns } from "../../src/sources/runs.js"
import { readRuntimes } from "../../src/sources/runtimes.js"
import { localOwnerOf } from "../../src/provider/owner.js"
import type { RunRecord, RuntimeRecord } from "../../src/provider/ports.js"
import { FakeClock, FakeColabApi, MemoryLedger } from "../fakes/index.js"

const OWNER = localOwnerOf("runner", "fixture")

const runtime = (id: string, account: string): RuntimeRecord => ({
  id,
  account,
  backend: "colab",
  spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" },
  createdAt: "2026-11-21T08:00:00.000Z",
  nonce: "0123456789abcdef0123456789abcdef",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
})

const run = (runId: string, account: string, runtimeId: string, name = "analysis.ipynb"): RunRecord => ({
  runId,
  account,
  backend: "colab",
  state: "ok",
  runtime: runtimeId,
  spec: "T4 GPU",
  startedAt: "2026-11-21T08:10:00.000Z",
  endedAt: "2026-11-21T08:12:30.000Z",
  cellIds: ["cell-1"],
  outputPaths: [],
  notebook: name,
})

describe("colab.runs", () => {
  test("a page is oldest first, hashed and carries a bound cursor", async () => {
    const clock = new FakeClock(new Date("2026-11-21T09:00:00.000Z"))
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime(runtime("oc-work", "work"))
    await ledger.putRun(run("run-1", "work", "oc-work"))
    await ledger.putRun(run("run-2", "work", "oc-work"))
    const page = await listRuns({ ledger, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100 })
    expect(page.source).toBe("runs")
    expect(page.account).toBe("work")
    expect(page.events).toHaveLength(2)
    expect(page.events.map((event) => event.external_id)).toEqual(["run-1", "run-2"])
    expect(page.events[0]!.kind).toBe("x-colab/run")
    expect(page.events[0]!.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(page.trust).toBe("untrusted")
    expect(page.more).toBe(false)
    expect(typeof page.cursor).toBe("string")
  })

  test("a cursor from another account is CURSOR_INVALID, and a reset ledger answers one gap", async () => {
    const clock = new FakeClock(new Date("2026-11-21T09:00:00.000Z"))
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime(runtime("oc-work", "work"))
    await ledger.putRun(run("run-1", "work", "oc-work"))
    const page = await listRuns({ ledger, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100 })
    await expect(listRuns({ ledger, clock, ledgerDays: 90 }, "personal", OWNER, { limit: 100, cursor: page.cursor })).rejects.toMatchObject({ refusal: { code: "CURSOR_INVALID" } })

    const fresh = new MemoryLedger(clock)
    const reset = await listRuns({ ledger: fresh, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100, cursor: page.cursor })
    expect(reset.gap).toEqual({ reason: "expired", since: JSON.parse(Buffer.from(page.cursor, "base64url").toString("utf8")).t })
    const next = await listRuns({ ledger: fresh, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100, cursor: reset.cursor })
    expect(next.gap).toBeUndefined()
  })

  test("a secret-shaped title is refused, not delivered", async () => {
    const clock = new FakeClock(new Date("2026-11-21T09:00:00.000Z"))
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime(runtime("oc-work", "work"))
    await ledger.putRun(run("run-1", "work", "oc-work", ["sk", "abcdefghijklmnopqrstuvwxyz012345"].join("-")))
    const page = await listRuns({ ledger, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100 })
    expect(page.events).toHaveLength(0)
    expect(page.refused?.[0]).toMatchObject({ external_id: "run-1", reason: "secret" })
  })

  test("a malformed cursor is refused rather than restarted", async () => {
    const clock = new FakeClock()
    const ledger = new MemoryLedger(clock)
    await expect(listRuns({ ledger, clock, ledgerDays: 90 }, "work", OWNER, { limit: 100, cursor: "not-a-cursor" })).rejects.toBeInstanceOf(RegisterError)
  })
})

describe("colab.runtimes", () => {
  test("is a table with the plugin's own runtimes marked", async () => {
    const clock = new FakeClock(new Date("2026-11-21T09:00:00.000Z"))
    const ledger = new MemoryLedger(clock)
    await ledger.putRuntime(runtime("oc-work", "work"))
    const colab = new FakeColabApi()
    colab.runtimes.set("oc-work", { name: "runtimes/oc-work", spec: runtime("oc-work", "work").spec })
    colab.runtimes.set("someone-else", { name: "runtimes/someone-else", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } })
    const snapshot = await readRuntimes(
      { colab, vertex: { listRuntimes: async () => [] } as never, ledger, prices: { usdPerHour: () => undefined } as never, clock },
      { alias: "work", backend: "colab", mode: "interactive", access: "write", drive: true, runAsUser: false },
      new AbortController().signal,
    )
    expect(snapshot.trust).toBe("untrusted")
    const checked = checkOutput("table", snapshot.data)
    expect(checked.ok, checked.ok ? "" : checked.problems.join("; ")).toBe(true)
    const rows = snapshot.data.rows as readonly Record<string, unknown>[]
    expect(rows.find((row) => row.id === "oc-work")).toMatchObject({ ours: true, backend: "colab" })
    expect(rows.find((row) => row.id === "someone-else")).toMatchObject({ ours: false })
  })

  test("more rows than the bound is TOO_LARGE", async () => {
    const clock = new FakeClock()
    const colab = new FakeColabApi()
    for (let index = 0; index < 101; index++) colab.runtimes.set(`r${index}`, { name: `runtimes/r${index}`, spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } })
    await expect(
      readRuntimes(
        { colab, vertex: { listRuntimes: async () => [] } as never, ledger: new MemoryLedger(clock), prices: { usdPerHour: () => undefined } as never, clock },
        { alias: "work", backend: "colab", mode: "interactive", access: "write", drive: true, runAsUser: false },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ refusal: { code: "TOO_LARGE" } })
  })
})
