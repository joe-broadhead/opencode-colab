// The reviewer's reproduction for colab #15 (03adf8c), R1, kept as written: a run whose end is recorded between the
// source's ledger reads must still be listed (reviews/wave-B/colab-15-repro.test.ts).
import { parseEventsListInput } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it } from "vitest"
import type { Ledger, RunRecord } from "../../src/ports.js"
import { listRuns } from "../../src/sources/runs.js"
import { FakeClock, MemoryLedger } from "../fakes/index.js"

const NOW = new Date("2026-11-17T12:00:00.000Z")
const OWNER = { id: "os-user:me@host", label: "me on host" }
const request = (input: Record<string, unknown>) => {
  const parsed = parseEventsListInput({ limit: 50, ...input })
  if (!parsed.ok) throw new Error(parsed.problems.join("; "))
  return parsed.value
}

const job = (state: RunRecord["state"], endedAt?: string): RunRecord => ({
  runId: "job-x",
  account: "default",
  backend: "enterprise",
  job: "projects/p/locations/us-central1/notebookExecutionJobs/job-x",
  startedAt: "2026-11-17T11:00:00.000Z",
  ...(endedAt ? { endedAt } : {}),
  state,
  cellIds: [],
  outputPaths: [],
  summary: "Colab Enterprise job",
})

describe("reviewer repro, colab #15", () => {
  it("R1: a run that becomes final between the source's two ledger reads is still listed on a later read", async () => {
    const clock = new FakeClock(NOW)
    const ledger = new MemoryLedger(clock)
    await ledger.putRun(job("running"))
    await ledger.append({ type: "runtime.released", id: "oc-other", account: "default" }) // so the log is not empty
    const deps = { ledger: ledger as Ledger, clock, ledgerDays: 90 }

    const first = await listRuns(deps, "default", OWNER, request({ since: "2026-11-16T00:00:00.000Z" }))
    expect(first.events).toEqual([])

    // Package E's writer (src/enterprise/runs.ts record()): putRun with the final state, then append run.finished.
    // It lands after the source's listRuns() and before its eventsSince(): two processes, or one await apart.
    let raced = false
    const racing = new Proxy(ledger, {
      get(target, key, receiver) {
        if (key === "eventsSince") {
          return async (seq: number, limit: number) => {
            if (!raced) {
              raced = true
              await target.putRun(job("ok", "2026-11-17T11:59:00.000Z"))
              await target.append({ type: "run.finished", id: "job-x", account: "default" })
            }
            return target.eventsSince(seq, limit)
          }
        }
        const value = Reflect.get(target, key, receiver)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    const listed: string[] = []
    let cursor = first.cursor
    for (const reader of [racing, ledger, ledger]) {
      const page = await listRuns({ ...deps, ledger: reader as Ledger }, "default", OWNER, request({ cursor }))
      listed.push(...page.events.map((event) => event.external_id))
      cursor = page.cursor
    }
    expect(listed).toEqual(["job-x"])
  })
})
