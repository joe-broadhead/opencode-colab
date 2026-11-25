/**
 * The `colab.runs` source: one event per finished run or Enterprise job this plugin started, from its own ledger.
 * No network call and no Google read; a page works with no account signed in.
 *
 * The cursor is bound to `(colab, runs, account)`. A page walks the ledger's append log after the cursor in order, so a
 * burst drains and the cursor moves on every page; an expired window answers one `gap: expired`; a ledger that was reset
 * (its sequence numbers or the time at the cursor changed) answers the same gap instead of refusing its own cursor.
 */
import { decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/plugin-contract/cursor"
import { eventsListResult, makeEvent, oldestFirst, screenEvents, type EventsGap, type EventsListRequest, type EventsListResult, type EventsOwner, type RefusedEvent, type SourceEvent } from "@we-the-rebel-alliance/plugin-contract/events"
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { isFinal } from "../provider/ledger/store.js"
import type { Clock, Ledger, LedgerEvent, RunRecord, RuntimeRecord } from "../provider/ports.js"

/** The plugin's package name: every page names it. */
export const PACKAGE = "@we-the-rebel-alliance/colab-plugin"
/** The source's name, as `events_list`'s `source` input and every page name it. */
export const RUNS = "runs"
export const RUNS_ID = "colab.runs"
/** Every event's kind: the plugin's own, one finished run or job. */
export const RUN_KIND = "x-colab/run"
/** The most JSON one page holds. */
export const RUNS_MAX_BYTES = 131_072
const ENVELOPE_BYTES = 4_096
const DAY = 86_400_000
const FIRST_RUN_HOURS = 24

export interface RunsCursor {
  readonly q: number
  readonly h?: string
  readonly t: string
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const isIso = (value: unknown): value is string => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value))

export const runsBinding = (account: string): CursorBinding => ({ plugin: "colab", source: RUNS, account })

export function encodeRunsCursor(account: string, state: RunsCursor): string {
  return encodeBoundCursor(runsBinding(account), { q: state.q, ...(state.h !== undefined ? { h: state.h } : {}), t: state.t })
}

export function decodeRunsCursor(account: string, cursor: string): RunsCursor {
  const decoded = decodeBoundCursor(runsBinding(account), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const q = state?.["q"]
  const h = state?.["h"]
  const t = state?.["t"]
  const keys = state ? Object.keys(state).filter((key) => key !== "q" && key !== "h" && key !== "t") : []
  if (!state || typeof q !== "number" || !Number.isSafeInteger(q) || q < 0 || !isIso(t) || (h !== undefined && !isIso(h)) || keys.length > 0) {
    throw new RegisterError(refusal("CURSOR_INVALID", `The cursor is ${decoded.ok ? "not one colab.runs issued" : decoded.reason} for the account ${account}`, "Call events_list again without a cursor, with since, to start over."))
  }
  return { q, ...(h !== undefined ? { h } : {}), t }
}

export interface RunsDeps {
  readonly ledger: Ledger
  readonly clock: Clock
  readonly ledgerDays: number
}

export { isFinal }

export const announces = (entry: LedgerEvent, run: RunRecord): boolean =>
  entry.type === "run.finished" && entry.id === run.runId && entry.account === run.account && Date.parse(entry.at) > Date.parse(run.startedAt)

export const SWEEP_MAX = 200

export async function sweepFinished(deps: RunsDeps, account: string, runs: readonly RunRecord[], log: readonly LedgerEvent[]): Promise<number> {
  const keptFrom = deps.clock.now().getTime() - Math.max(0, deps.ledgerDays - 1) * DAY
  const entries = new Map<string, LedgerEvent[]>()
  for (const entry of log) if (entry.type === "run.finished" && entry.account === account) (entries.get(entry.id) ?? entries.set(entry.id, []).get(entry.id)!).push(entry)
  const unannounced = runs
    .filter((run): run is RunRecord & { readonly endedAt: string } => run.account === account && isFinal(run) && Date.parse(run.endedAt) >= keptFrom)
    .filter((run) => !(entries.get(run.runId) ?? []).some((entry) => announces(entry, run)))
    .sort((a, b) => Date.parse(a.endedAt) - Date.parse(b.endedAt))
    .slice(0, SWEEP_MAX)
  for (const run of unannounced) await deps.ledger.append({ type: "run.finished", id: run.runId, account })
  return unannounced.length
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`

/** A duration in the plugin's words: 42 s, 12 min, 3 h 5 min, 2 d 3 h. */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return hours % 24 ? `${Math.floor(hours / 24)} d ${hours % 24} h` : `${Math.floor(hours / 24)} d`
}

const OUTCOME: Readonly<Record<RunRecord["state"], string>> = {
  ok: "finished",
  error: "failed",
  failed: "failed",
  cancelled: "was cancelled",
  timeout: "timed out",
  running: "is running",
  detached: "is detached",
}

const JOB_OUTCOME: Readonly<Record<RunRecord["state"], string>> = { ...OUTCOME, ok: "succeeded" }

const lastSegment = (text: string) => text.split(/[\\/]/).filter(Boolean).at(-1) ?? text
const short = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** A finished run in the plugin's own words: what ran, where, how it ended and for how long. */
export function titleOf(run: RunRecord & { readonly endedAt: string }, runtime?: RuntimeRecord): string {
  const took = duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
  const code = run.errorCode ? ` (${run.errorCode})` : ""
  const notebook = run.notebook ? short(lastSegment(run.notebook), 80) : undefined
  if (run.backend === "enterprise") {
    const job = short(lastSegment(run.job ?? run.runId), 64)
    return `Colab Enterprise job ${job}${notebook ? ` of ${notebook}` : ""} ${JOB_OUTCOME[run.state]}${code}, ${took}`
  }
  const where = short(run.spec ?? (runtime ? (runtime.spec.accelerator === "NONE" ? "CPU" : runtime.spec.accelerator) : "a Colab runtime"), 40)
  const what = notebook ? `${plural(run.cellIds.length, "cell")} of ${notebook}` : run.cellIds.length > 0 ? plural(run.cellIds.length, "cell") : "code"
  return `Ran ${what} on ${where} - ${OUTCOME[run.state]}${code}, ${took}`
}

/** One finished run as a contract event: plugin words only, no text, no link, no actors. */
export function eventOf(run: RunRecord & { readonly endedAt: string }, account: string, runtime?: RuntimeRecord): SourceEvent {
  const labels = [`backend:${run.backend}`, `state:${run.state}`]
  if (run.errorCode) labels.push(`code:${run.errorCode}`)
  if (runtime) labels.push(`accelerator:${runtime.spec.accelerator}`)
  if (run.runtime) labels.push(`runtime:${short(run.runtime, 55)}`)
  return makeEvent({
    source: RUNS,
    account,
    external_id: run.runId,
    kind: RUN_KIND,
    occurred_at: run.endedAt,
    thread: run.runtime ? `colab-runtime:${run.runtime}` : null,
    title: titleOf(run, runtime),
    text: "",
    url: null,
    labels,
  })
}

const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/** One page of `colab.runs` for `account`, whose owner the caller resolved. */
export async function listRuns(deps: RunsDeps, account: string, owner: EventsOwner, request: EventsListRequest): Promise<EventsListResult> {
  const from = request.cursor === undefined ? undefined : decodeRunsCursor(account, request.cursor)
  const now = deps.clock.now().getTime()

  let log = await deps.ledger.eventsSince(0, Number.MAX_SAFE_INTEGER)
  let runs = await deps.ledger.listRuns({ account })
  if ((await sweepFinished(deps, account, runs, log.events)) > 0) {
    log = await deps.ledger.eventsSince(0, Number.MAX_SAFE_INTEGER)
    runs = await deps.ledger.listRuns({ account })
  }

  const entries = log.events
  const oldest = log.oldest
  const newest = entries.length > 0 ? entries[entries.length - 1]!.seq : oldest - 1

  let q: number
  let t: string
  let h: string | undefined
  let gap: EventsGap | undefined
  let windowStart: number | undefined
  if (from) {
    const atQ = entries.find((entry) => entry.seq === from.q)
    const reset = from.q > newest || (atQ !== undefined && from.h !== undefined && atQ.at !== from.h)
    const expired = from.q < oldest - 1
    t = from.t
    if (reset || expired) {
      gap = { reason: "expired", since: from.t }
      q = oldest - 1
      h = undefined
    } else {
      q = from.q
      h = from.h
    }
  } else {
    windowStart = request.since ?? now - FIRST_RUN_HOURS * 3_600_000
    t = new Date(windowStart).toISOString()
    q = oldest - 1
    if (oldest > 1 && windowStart < now - deps.ledgerDays * DAY) gap = { reason: "expired", since: t }
  }

  const records = new Map(runs.map((run) => [run.runId, run]))
  const runtimes = new Map((await deps.ledger.listRuntimes({ account })).map((runtime) => [runtime.id, runtime]))
  const first = new Map<string, number>()
  for (const entry of entries) {
    const run = entry.account === account ? records.get(entry.id) : undefined
    if (run && !first.has(run.runId) && announces(entry, run)) first.set(run.runId, entry.seq)
  }

  const events: SourceEvent[] = []
  const refused: RefusedEvent[] = []
  let bytes = ENVELOPE_BYTES
  let more = false
  for (const entry of entries) {
    if (entry.seq <= q) continue
    const run = entry.type === "run.finished" && entry.account === account ? records.get(entry.id) : undefined
    const listed =
      run !== undefined &&
      isFinal(run) &&
      first.get(run.runId) === entry.seq &&
      (windowStart === undefined || (Date.parse(entry.at) >= windowStart && Date.parse(run.endedAt) >= windowStart))
    if (listed) {
      if (events.length + refused.length >= request.limit) {
        more = true
        break
      }
      const event = eventOf(run, account, run.runtime ? runtimes.get(run.runtime) : undefined)
      const screened = screenEvents([event])
      const size = screened.events.length > 0 ? bytesOf(event) + 1 : bytesOf(screened.refused[0]) + 1
      if (events.length + refused.length > 0 && bytes + size > RUNS_MAX_BYTES) {
        more = true
        break
      }
      bytes += size
      events.push(...screened.events)
      refused.push(...screened.refused)
    }
    q = entry.seq
    h = entry.at
    t = entry.at > t ? entry.at : t
  }

  const cursor = encodeRunsCursor(account, { q, ...(h !== undefined ? { h } : {}), t })
  return eventsListResult({ source: RUNS, account, owner }, oldestFirst(events), cursor, more, {
    ...(refused.length > 0 ? { refused } : {}),
    ...(gap ? { gap } : {}),
    plugin: PACKAGE,
    asOf: new Date(now).toISOString(),
  })
}
