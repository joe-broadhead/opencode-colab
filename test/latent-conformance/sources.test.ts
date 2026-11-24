// Synthetic conformance of latent source code only. No installed declaration or release evidence is produced.
import { describe, expect, test } from "bun:test"
import { encodeBoundCursor } from "@we-the-rebel-alliance/source-contract/cursor"
import { assertConformance, declarationProblems, sourceConformance, type ConformanceReport, type PageCase, type SessionContext } from "@we-the-rebel-alliance/source-contract/conformance"
import { acceptAnswer } from "@we-the-rebel-alliance/source-contract/read"
import { SOURCES_SCHEMA } from "@we-the-rebel-alliance/source-contract/schema"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { encodeRunsCursor, PACKAGE, probeSource } from "../../src/sources/index.js"
import { runsBinding } from "../../src/sources/runs.js"
import { METHOD_NAMES, TOOLS_RPC_ID } from "../../src/tools-rpc.js"
import { TOOLS } from "../../src/domain/actions.js"
import type { ToolName } from "../../src/domain/contract.js"
import { CPU, T4 } from "../fakes/index.js"
import { callOf, consumerRun, enterpriseJob, HOME, LAB, ourRuntime, sourcesHarness } from "../fakes/sources-harness.js"
import { PACKAGE_NAME, PACKAGE_VERSION, latentSources } from "../fakes/sources-descriptor.js"

const NOW = Date.parse("2026-11-17T12:00:00.000Z")
const MIN = 60_000
const HOUR = 3_600_000
const DAY = 86_400_000
const iso = (ms: number) => new Date(ms).toISOString()

const fixture = latentSources()
const checked = SOURCES_SCHEMA.check(fixture)
if (!checked.ok) throw new Error(`the sources declaration is invalid: ${checked.problems.join("; ")}`)
const sources = checked.value
const tools = METHOD_NAMES.map((id) => ({ id, readOnly: id === "probe" || TOOLS.find((tool) => tool.name === id)?.class === "read" }))

// ── The fixture: a ledger with history the ledger has pruned, a day of runs, and runtimes on both backends ──

const h = sourcesHarness()
h.fakes.clock.current = new Date(NOW - 100 * DAY)
for (let index = 0; index < 3; index++) await consumerRun(h.ledger, { runId: `pruned-${index}`, start: NOW - 100 * DAY - HOUR, end: NOW - 100 * DAY, append: true })
h.fakes.clock.current = new Date(NOW - 20 * HOUR)
await ourRuntime(h.ledger, "oc-01jconformanceruntime000000", HOME, iso(NOW - 21 * HOUR))
await consumerRun(h.ledger, { runId: "run-analysis", start: NOW - 20 * HOUR - 10 * MIN, end: NOW - 20 * HOUR, notebook: "analysis.ipynb", cells: 6, runtime: "oc-01jconformanceruntime000000", append: true })
h.fakes.clock.current = new Date(NOW - 6 * HOUR)
await consumerRun(h.ledger, { runId: "run-secret", start: NOW - 6 * HOUR - MIN, end: NOW - 6 * HOUR, notebook: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.ipynb", append: true })
// Package D's shape: the end is recorded and no entry appended; the read's sweep lists it.
await consumerRun(h.ledger, { runId: "run-scratch", start: NOW - 3 * HOUR - 42_000, end: NOW - 3 * HOUR, cells: 0 })
h.fakes.clock.current = new Date(NOW - HOUR)
await enterpriseJob(h.ledger, { runId: "job-nightly", account: HOME, start: NOW - 9 * HOUR, end: NOW - 2 * HOUR, notebook: "nightly.ipynb", state: "failed" })
h.fakes.clock.current = new Date(NOW)
await h.ledger.prune(h.fakes.clock.now())
h.fakes.colab.runtimes.set("oc-01jconformanceruntime000000", { name: "runtimes/oc-01jconformanceruntime000000", spec: T4 })
h.fakes.colab.runtimes.set("browser-runtime", { name: "runtimes/browser-runtime", spec: CPU })
h.fakes.vertex.runtimes.set("rt", { name: "projects/invented-project/locations/us-central1/notebookRuntimes/rt-1", state: "RUNNING", machineType: "e2-standard-4", idleShutdownMinutes: 180 })

/** The plugin's runner, asserting through the kit's session permission, as the tools RPC binds a script's call. */
const runnerFor = (context: SessionContext): Runner => ({
  deps: h.deps,
  handler: h.runner.handler,
  assert: (request) => context.permission.assert({ action: request.action, resources: [...request.resources] }),
})
const run = (context: SessionContext, name: ToolName, input: Readonly<Record<string, unknown>>) => runTool(name, input, callOf(), runnerFor(context))

const expiredCursor = encodeRunsCursor(HOME, { q: 1, h: iso(NOW - 100 * DAY), t: iso(NOW - 100 * DAY) })
const cases: PageCase[] = [
  { name: "the last day, one secret-shaped title refused and one run swept", input: { source: "runs", account: HOME, since: iso(NOW - DAY) }, expect: "page" },
  { name: "two a page", input: { source: "runs", account: HOME, since: iso(NOW - DAY), limit: 2 }, expect: "page" },
  { name: "nothing since the last run", input: { source: "runs", account: HOME, since: iso(NOW - 30 * MIN) }, expect: "empty" },
  { name: "a cursor past the ledger's retention, read one a page", input: { source: "runs", account: HOME, cursor: expiredCursor, limit: 1 }, expect: "expired" },
  { name: "another account's cursor", input: { source: "runs", account: HOME, cursor: encodeRunsCursor(LAB, { q: 1, t: iso(NOW) }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "another plugin's cursor", input: { source: "runs", account: HOME, cursor: encodeBoundCursor({ ...runsBinding(HOME), plugin: "other-plugin" }, { q: 1, t: iso(NOW) }) }, expect: { refuses: "CURSOR_INVALID" } },
  { name: "another source's name", input: { source: "jobs", account: HOME }, expect: { refuses: "SOURCE_UNKNOWN" } },
]

const reports: ConformanceReport[] = []
const extra: { name: string; ok: boolean; detail: string }[] = []

describe("the source contract's conformance kit", () => {
  test("the declaration validates as a consumer reads it", () => {
    expect(declarationProblems(fixture, { tools })).toEqual([])
    expect(sources.rpc).toBe(TOOLS_RPC_ID)
    expect(sources.items.map((item) => item.id)).toEqual(["colab.runs", "colab.runtimes"])
  })

  for (const source of sources.items) {
    test(`${source.id} keeps the contract`, async () => {
      const events = source.kind === "events"
      const report = await sourceConformance({
        plugin: PACKAGE,
        source,
        tools,
        account: HOME,
        identityOperations: [],
        sources: { rpc: sources.rpc, ...(sources.probe ? { probe: sources.probe } : {}) },
        describe: { id: TOOLS_RPC_ID },
        ...(events ? { atomicPages: { reason: "a page is one read of the plugin's local ledger: a failure fails the whole call, so no single run can fail on its own" } } : {}),
        calls: {
          list: (input, context) => run(context, "events_list", input),
          probe: (input, context) => probeSource(runnerFor(context), input, callOf()),
          snapshot: (input, context) => run(context, "runtimes_read", input),
        },
        cases: events ? cases : [],
        snapshotCases: events ? [] : [{ source: "runtimes", account: HOME }, { source: "runtimes", account: LAB }],
      })
      assertConformance(report)
      reports.push(report)
      expect(report.ok).toBe(true)
      expect(report.incomplete).toBe(false)
      for (const check of report.checks) expect(check.ran || check.notApplicable).toBe(true)
      // The checks that matter for a cursor ran for real, not as not-applicable.
      if (events) for (const name of ["page-result", "gap-and-cursor-expired", "gap-once-per-read", "refused-is-final", "unused-grants", "probe"]) expect(report.checks.find((check) => check.name === name)?.ran).toBe(true)
    })
  }

  test("beyond the kit: the probe's account mismatch, the list snapshot as a consumer validates it, and TOO_LARGE", async () => {
    const context = { account: HOME, permission: { assert: async () => undefined } } as unknown as SessionContext
    const mismatch = await probeSource(runnerFor(context), { source: "runs", account: "work" }, callOf()).then(
      () => "answered",
      (error: Error) => error.message,
    )
    extra.push({ name: "probe-account-mismatch", ok: /^ACCOUNT_MISMATCH: /.test(mismatch), detail: mismatch.split(".")[0]! })
    const runtimes = sources.items.find((item) => item.id === "colab.runtimes")!
    for (const account of [HOME, LAB]) {
      const accepted = acceptAnswer(runtimes, account, await run(context, "runtimes_read", { source: "runtimes", account }))
      extra.push({ name: `list-snapshot-${account}`, ok: accepted.ok, detail: accepted.ok ? "acceptAnswer validated data against output.list" : JSON.stringify(accepted.failure) })
    }
    for (let index = 0; index < 51; index++) h.fakes.colab.runtimes.set(`extra-${index}`, { name: `runtimes/extra-${index}`, spec: CPU })
    const large = await run(context, "runtimes_read", { source: "runtimes", account: HOME }).then(
      () => "answered",
      (error: Error) => error.message,
    )
    extra.push({ name: "too-large", ok: /^TOO_LARGE: /.test(large), detail: large.split(".")[0]! })
    for (const entry of extra) expect(entry.ok, `${entry.name}: ${entry.detail}`).toBe(true)
  })

  test("has two complete synthetic runs and all four extra checks", () => {
    const report = {
      ok: reports.length === 2 && reports.every((entry) => entry.ok && !entry.incomplete) && extra.length === 4 && extra.every((entry) => entry.ok),
      plugin: PACKAGE_NAME,
      version: PACKAGE_VERSION,
      contract: { package: "@we-the-rebel-alliance/source-contract", tag: "v0.3.0" },
      sources: reports,
      extra,
    }
    expect(report.ok).toBe(true)
  })
})
