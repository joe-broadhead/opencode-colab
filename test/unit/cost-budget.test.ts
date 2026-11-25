// The opt-in budgets (design §8.5): per account, a daily window, `warn` or `refuse`, and the proposed amount always
// counted. Consumer runtime-hours come from the ledger and are complete; Enterprise USD comes from the ledger's runs
// and is a floor when a record does not name its compute, in which case `refuse` degrades to `warn`.
import { describe, expect, it } from "vitest"
import { createBudget } from "../../src/provider/cost/budget.js"
import { consumerUsage, dayStart, enterpriseUsage, runUsd, runtimeHoursBetween } from "../../src/provider/cost/usage.js"
import { loadOptions } from "../../src/options.js"
import type { RunRecord, RuntimeRecord } from "../../src/provider/ports.js"
import { FakeClock, FakePrices, MemoryLedger, T4 } from "../fakes/index.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const ID = "oc-01jcostbudget0000000000"

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

const run = (overrides: Partial<RunRecord> & { readonly estimatedUsd?: number } = {}): RunRecord => ({
  runId: "oc-job-1",
  account: "default",
  backend: "enterprise",
  startedAt: "2026-11-17T09:00:00.000Z",
  endedAt: "2026-11-17T10:00:00.000Z",
  state: "ok",
  cellIds: [],
  outputPaths: [],
  ...overrides,
})

async function world(input: { budget?: unknown; runtimes?: readonly RuntimeRecord[]; runs?: readonly RunRecord[] } = {}) {
  const clock = new FakeClock(NOW)
  const ledger = new MemoryLedger(clock)
  for (const item of input.runtimes ?? []) await ledger.putRuntime(item)
  for (const item of input.runs ?? []) await ledger.putRun(item)
  const options = await loadOptions(input.budget === undefined ? {} : { accounts: { default: { budget: input.budget } } })
  const prices = new FakePrices()
  return { clock, ledger, options, prices, budget: createBudget({ options, ledger, clock, prices }) }
}

describe("the usage arithmetic", () => {
  it("counts only the part of a record's life in the window", () => {
    const from = new Date("2026-11-17T10:00:00.000Z")
    const to = new Date("2026-11-17T12:00:00.000Z")
    expect(runtimeHoursBetween({ createdAt: "2026-11-17T08:00:00.000Z" }, from, to)).toBe(2)
    expect(runtimeHoursBetween({ createdAt: "2026-11-17T11:00:00.000Z" }, from, to)).toBe(1)
    expect(runtimeHoursBetween({ createdAt: "2026-11-17T11:00:00.000Z", releasedAt: "2026-11-17T11:30:00.000Z" }, from, to)).toBe(0.5)
    expect(runtimeHoursBetween({ createdAt: "2026-11-17T13:00:00.000Z" }, from, to)).toBe(0)
  })

  it("prices a run by the estimatedUsd E stamps at its commit, else by the machine its spec names", () => {
    const prices = new FakePrices()
    expect(runUsd(run({ estimatedUsd: 1.25 }), prices, NOW)).toBe(1.25)
    expect(runUsd(run(), prices, NOW)).toBeUndefined()
    expect(runUsd(run({ estimatedUsd: -1 }), prices, NOW)).toBeUndefined()
    expect(runUsd(run({ spec: "e2-standard-4" }), prices, NOW)).toBeCloseTo(0.19, 5)
  })

  it("reports how many runs of the day it could not price", () => {
    const usage = enterpriseUsage([run({ estimatedUsd: 2 }), run({ runId: "oc-job-2" }), { ...run({ runId: "oc-job-3" }), backend: "colab" }], new FakePrices(), dayStart(NOW), NOW)
    expect(usage).toEqual({ runs: 2, usd: 2, unpriced: 1 })
  })

  it("counts a live runtime's hours from today's start", () => {
    const usage = consumerUsage([record(), record({ id: "oc-2", createdAt: "2026-11-17T11:00:00.000Z" })], NOW, dayStart(NOW))
    expect(usage.running).toBe(2)
    expect(usage.runtimeHours).toBeCloseTo(3, 5)
  })
})

describe("the budget", () => {
  it("answers ok when the account has no budget", async () => {
    const worldOf = await world()
    expect(await worldOf.budget.check("default", { action: "runtime.create" }, new AbortController().signal)).toEqual({ verdict: "ok" })
    expect(await worldOf.budget.check("default", { action: "job.create", usd: 100 }, new AbortController().signal)).toEqual({ verdict: "ok" })
  })

  it("counts runtime-hours today and the create's own proposal, and warns or refuses as the account says", async () => {
    const warn = await world({ budget: { runtimeHoursDaily: 3, action: "warn" }, runtimes: [record()] })
    expect(await warn.budget.check("default", { action: "runtime.create" }, new AbortController().signal)).toEqual({ verdict: "warn", spent: 2, limit: 3, unit: "runtime-hours" })
    expect(await warn.budget.check("default", { action: "runtime.create", runtimeHours: 0.5 }, new AbortController().signal)).toEqual({ verdict: "ok" })

    const refuse = await world({ budget: { runtimeHoursDaily: 3, action: "refuse" }, runtimes: [record()] })
    expect(await refuse.budget.check("default", { action: "runtime.create" }, new AbortController().signal)).toMatchObject({ verdict: "refuse" })
  })

  it("refuses a job whose own estimate is over the daily USD limit, and degrades to warn only when the day cannot be measured", async () => {
    const measured = await world({ budget: { enterpriseUsdDaily: 5, action: "refuse" }, runs: [run({ estimatedUsd: 3 })] })
    expect(await measured.budget.check("default", { action: "job.create", usd: 3 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 3, limit: 5, unit: "usd" })
    expect(await measured.budget.check("default", { action: "job.create", usd: 1 }, new AbortController().signal)).toEqual({ verdict: "ok" })

    // A run without an estimate contributes nothing: the counted spend plus the call still refuses, and the
    // answer says the unit it counted in.
    const floor = await world({ budget: { enterpriseUsdDaily: 5, action: "refuse" }, runs: [run({ estimatedUsd: 3 }), run({ runId: "oc-job-2" })] })
    expect(await floor.budget.check("default", { action: "job.create", usd: 2 }, new AbortController().signal)).toEqual({ verdict: "ok" })
    expect(await floor.budget.check("default", { action: "job.create", usd: 3 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 3, limit: 5, unit: "usd" })
  })

  it("ignores yesterday's runs and a run nobody asked the budget about", async () => {
    const worldOf = await world({ budget: { enterpriseUsdDaily: 1, action: "refuse" }, runs: [run({ startedAt: "2026-11-16T09:00:00.000Z", estimatedUsd: 100 })] })
    expect(await worldOf.budget.check("default", { action: "job.create", usd: 0.5 }, new AbortController().signal)).toEqual({ verdict: "ok" })
  })

  it("has no opinion about a different account, or about a limit it does not set", async () => {
    const worldOf = await world({ budget: { runtimeHoursDaily: 1, action: "refuse" }, runtimes: [record()] })
    expect(await worldOf.budget.check("other", { action: "runtime.create" }, new AbortController().signal)).toEqual({ verdict: "ok" })
    expect(await worldOf.budget.check("default", { action: "job.create", usd: 100 }, new AbortController().signal)).toEqual({ verdict: "ok" })
  })

  it("refuses the third $5 job against a $10 daily limit, as the day's committed estimates add up", async () => {
    const worldOf = await world({ budget: { enterpriseUsdDaily: 10, action: "refuse" }, runs: [run({ estimatedUsd: 5 }), run({ runId: "oc-job-2", estimatedUsd: 5 })] })
    expect(await worldOf.budget.check("default", { action: "job.create", usd: 5 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 10, limit: 10, unit: "usd" })
    expect(await worldOf.budget.check("default", { action: "job.create", usd: 0.5 }, new AbortController().signal)).toEqual({ verdict: "refuse", spent: 10, limit: 10, unit: "usd" })
  })
})
