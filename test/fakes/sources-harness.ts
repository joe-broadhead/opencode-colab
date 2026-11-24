/**
 * Package G's harness: the plugin's real tool wrapper (src/tools/spec.ts `runTool`) and registry over Day 0's fakes,
 * with the strict ledger (sources-ledger.ts), a recording permission, the source probe, the run writers the source
 * must cope with, and a consumer that reads a source the way a collector does: page after page with the cursor
 * the last page gave, each page checked against the contract (`resultProblems`).
 *
 * The run writers are the ledger's real writers, by shape (src/enterprise/runs.ts `record`; package D's
 * `finishRecord` on pkg/execution 9d7fd53): E records a job's end with Google's `endTime` and appends `run.finished`;
 * D records a consumer run's end and appends nothing.
 */
import { resultProblems, type EventsListResult, type SourceEvent } from "@we-the-rebel-alliance/source-contract/events"
import type { ToolName } from "../../src/domain/contract.js"
import type { Deps } from "../../src/deps.js"
import type { Ledger, RunRecord, RuntimeRecord } from "../../src/ports.js"
import { probeSource } from "../../src/sources/index.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { toolHandlers } from "../../src/tools/registry.js"
import type { ToolCall } from "../../src/tools/types.js"
import { CPU, fakeDeps, RecordingPermission, T4, type Fakes } from "./index.js"
import { SourcesLedger } from "./sources-ledger.js"

export const HOME = "home"
export const LAB = "lab"
/** Two accounts, one per backend, both writable (named accounts are read-only by default; reads do not care). */
export const TWO_ACCOUNTS = {
  accounts: {
    home: { backend: "colab", access: "write" },
    lab: { backend: "enterprise", project: "invented-project", region: "us-central1", outputBucket: "gs://invented-bucket/runs", serviceAccount: "runner@invented-project.iam.gserviceaccount.com", access: "write" },
  },
}

export interface Harness {
  readonly deps: Deps
  readonly fakes: Fakes
  readonly ledger: Ledger
  readonly permission: RecordingPermission
  readonly runner: Runner
  tool(name: ToolName, input: Record<string, unknown>): Promise<unknown>
  probe(input: Record<string, unknown>): Promise<unknown>
}

let calls = 0
export const callOf = (): ToolCall => ({ sessionID: "ses_sources", agent: "build", messageID: "msg_sources", id: `call_${++calls}`, signal: new AbortController().signal })

export function sourcesHarness(input: { readonly options?: unknown; readonly directory?: string; readonly ledger?: (fakes: Fakes, ledgerDays: number) => Ledger } = {}): Harness {
  const made = fakeDeps({ options: input.options ?? TWO_ACCOUNTS, ...(input.directory !== undefined ? { directory: input.directory } : {}) })
  const ledger = input.ledger ? input.ledger(made.fakes, made.options.ledgerDays) : new SourcesLedger(made.fakes.clock, made.options.ledgerDays)
  const deps: Deps = { ...made.deps, ledger }
  // Both accounts are signed in by default: home interactively with an ID token, lab with application default creds.
  made.fakes.auth.grants.set(HOME, ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/colaboratory"])
  made.fakes.auth.emails.set(HOME, "ada@example.invalid")
  made.fakes.auth.grants.set(LAB, ["https://www.googleapis.com/auth/cloud-platform"])
  made.fakes.auth.emails.set(LAB, "runner@invented-project.iam.gserviceaccount.com")
  const permission = new RecordingPermission()
  let handlers: ReturnType<typeof toolHandlers> | undefined
  const runner: Runner = { deps, assert: permission.assert, handler: (name) => (handlers ??= toolHandlers(() => runner))[name] }
  return {
    deps,
    fakes: made.fakes,
    ledger,
    permission,
    runner,
    tool: (name, raw) => runTool(name, raw, callOf(), runner),
    probe: (raw) => probeSource(runner, raw, callOf()),
  }
}

// ── Writers ────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString()

/** A runtime of the plugin's own, as package D's create plan records it. */
export async function ourRuntime(ledger: Ledger, id: string, account = HOME, createdAt = "2026-11-17T08:00:00.000Z", accelerator: "T4" | "NONE" = "T4"): Promise<RuntimeRecord> {
  const record: RuntimeRecord = {
    id,
    account,
    backend: "colab",
    spec: accelerator === "T4" ? T4 : CPU,
    createdAt,
    nonce: "invented-nonce",
    keep: ["/content/outputs/**"],
    lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
    state: "ready",
  }
  await ledger.putRuntime(record)
  return record
}

/** Package D's shape: a run record written at start, then rewritten final at its end, with no `run.finished` entry. */
export async function consumerRun(ledger: Ledger, input: { readonly runId: string; readonly account?: string; readonly start: number; readonly end?: number; readonly state?: RunRecord["state"]; readonly notebook?: string; readonly cells?: number; readonly runtime?: string; readonly errorCode?: RunRecord["errorCode"]; readonly append?: boolean }): Promise<RunRecord> {
  const record: RunRecord = {
    runId: input.runId,
    account: input.account ?? HOME,
    backend: "colab",
    runtime: input.runtime ?? "oc-01jinventedruntime000000000",
    ...(input.notebook ? { notebook: input.notebook } : {}),
    cellIds: Array.from({ length: input.cells ?? 3 }, (_, index) => `cell-${index}`),
    spec: "T4 GPU",
    startedAt: iso(input.start),
    ...(input.end !== undefined ? { endedAt: iso(input.end) } : {}),
    state: input.end === undefined ? "running" : (input.state ?? "ok"),
    outputPaths: [],
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  }
  await ledger.putRun(record)
  if (input.end !== undefined && input.append) await ledger.append({ type: "run.finished", id: record.runId, account: record.account })
  return record
}

/**
 * Package E's shape (src/enterprise/runs.ts): `openJobCreate` writes the record at create; `record` writes it final with
 * Google's `endTime` when a read observes the end, then appends `run.finished`. `observed` is when that read happens.
 */
export async function enterpriseJob(ledger: Ledger, input: { readonly runId: string; readonly account?: string; readonly start: number; readonly end?: number; readonly state?: RunRecord["state"]; readonly notebook?: string; readonly append?: boolean }): Promise<RunRecord> {
  const record: RunRecord = {
    runId: input.runId,
    account: input.account ?? LAB,
    backend: "enterprise",
    job: `projects/invented-project/locations/us-central1/notebookExecutionJobs/${input.runId}`,
    ...(input.notebook ? { notebook: input.notebook } : {}),
    cellIds: [],
    startedAt: iso(input.start),
    ...(input.end !== undefined ? { endedAt: iso(input.end) } : {}),
    state: input.end === undefined ? "running" : (input.state ?? "ok"),
    outputPaths: [],
  }
  await ledger.putRun(record)
  if (input.end !== undefined && input.append !== false) await ledger.append({ type: "run.finished", id: record.runId, account: record.account })
  return record
}

// ── A consumer ──────────────────────────────────────────────────────────

export interface Drained {
  readonly cursor: string
  readonly events: SourceEvent[]
  readonly gaps: NonNullable<EventsListResult["gap"]>[]
  readonly refused: NonNullable<EventsListResult["refused"]>
  readonly pages: number
}

/**
 * One read, as a consumer makes it: pages until `more` is false, each page checked against the contract, at most one
 * gap a read (else it throws: a consumer would count a second resync), the cursor never moving backwards on a page
 * that lists nothing new. Returns what the read listed and the cursor to keep.
 */
export async function drain(tool: Harness["tool"], input: { readonly account?: string; readonly cursor?: string; readonly since?: string; readonly limit?: number }, maxPages = 10_000): Promise<Drained> {
  let cursor = input.cursor
  const events: SourceEvent[] = []
  const gaps: Drained["gaps"] = []
  const refused: NonNullable<EventsListResult["refused"]> = []
  for (let pages = 1; pages <= maxPages; pages++) {
    const answer = (await tool("events_list", {
      source: "runs",
      account: input.account ?? HOME,
      ...(cursor !== undefined ? { cursor } : input.since !== undefined ? { since: input.since } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    })) as EventsListResult
    const problems = resultProblems(answer, input.limit ?? 100, 131_072)
    if (problems.length > 0) throw new Error(`page ${pages} breaks the contract: ${problems.join("; ")}`)
    events.push(...answer.events)
    refused.push(...(answer.refused ?? []))
    if (answer.gap) gaps.push(answer.gap)
    if (gaps.length > 1) throw new Error(`the read answered ${gaps.length} gaps`)
    cursor = answer.cursor
    if (!answer.more) return { cursor, events, gaps, refused, pages }
  }
  throw new Error(`the read did not finish in ${maxPages} pages`)
}
