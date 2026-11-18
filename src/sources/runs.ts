/**
 * The `colab.runs` source (design §11): one event per finished run or Enterprise job this plugin started, from its own
 * ledger. No network call, no Google read: the ledger is the plugin's local record (src/ledger/store.ts).
 *
 * ## Where an event's position comes from
 *
 * The ledger's `events.jsonl` gives every entry a sequence number, assigned under the ledger's cross-process lock and
 * written copy-on-write, so the log a reader sees is always a whole prefix of what was appended: an entry can never
 * appear behind one already visible. A run's `run.finished` entry is appended when the run **becomes final** in the
 * ledger — when its end is recorded, not when it ended — so a job that ended hours ago and was observed only now gets
 * a position now. Keying the cursor on that sequence number means a run that lasts hours, or a job whose end is seen
 * late, is listed when it becomes final, behind nothing: there are no late arrivals and no ties to walk.
 *
 * ## The cursor
 *
 * `{ q, h, t }`, bound to the plugin, the source and the account (`encodeBoundCursor`): `q` the last sequence number
 * the cursor covers, `h` that entry's time (to recognise the same ledger), `t` the time history is covered up to (the
 * gap line). Its worst case is about 200 characters, far inside the contract's 1,024.
 *
 * - **A page** walks the log after `q` in order and covers every entry it passes, listed or not, so the cursor moves on
 *   every page that has an entry: a burst of any size drains (no jam), at most `limit` events and `maxBytes` a page.
 * - **Expired** (the ledger pruned entries after `q`: `ledgerDays`, 90 by default) answers one `gap: expired` from `t`,
 *   carried in the cursor (never recomputed from now: no sliding gap), and restarts at the oldest kept entry. The
 *   cursor it returns is inside the log, so the next page carries no gap: once per read.
 * - **A ledger that was reset** (deleted, or another machine's) is told by `q` past the newest entry, or the entry at `q`
 *   with another time than `h`: the same one gap, never a refusal. A plugin never refuses its own cursor; only a cursor
 *   that is not one (another binding, a malformed state) is CURSOR_INVALID.
 * - **A first read** (no cursor) lists runs that ended at or after `since` (24 h before now by default) and became final
 *   after it; it answers `gap: expired` from `since` only when the ledger has pruned entries and `since` is older than
 *   the ledger keeps.
 *
 * ## One listing per run
 *
 * A run is one ledger record per `runId`; a retried Enterprise create that reuses the id writes a fresh record with a
 * new start, so a run is the pair (`runId`, `startedAt`). An entry *announces* a record when it names its id and account
 * and was appended after its start. A record is listed at the first kept entry that announces it, while it is final:
 * a second entry for the same run (a race between two writers, or the sweep below) is passed over.
 *
 * ## The sweep: a final run with no entry
 *
 * Package E appends `run.finished` when it records a job's end; a writer that does not (package D records a consumer
 * run's end without one; a process can stop between the two writes) would leave a finished run unlisted for good. So
 * each read first appends `run.finished` for every final record of the account, within the ledger's retention, that no
 * kept entry announces, at most 200 a read (the sweep bound below). Its position is then the sweep's: the run is
 * listed on that read, or a later one, never silently skipped. The contract request to append the entry inside `putRun`
 * (src/ledger/store.ts) makes the sweep find nothing in practice.
 *
 * The read takes the log before the run records, and pages only that log against those records, so its cursor can
 * never pass an entry whose record it did not see final.
 */
import { decodeBoundCursor, encodeBoundCursor, type CursorBinding } from "@we-the-rebel-alliance/source-contract/cursor"
import {
  eventsListResult,
  makeEvent,
  oldestFirst,
  screenEvents,
  SourceError,
  startTime,
  type EventsGap,
  type EventsListRequest,
  type EventsListResult,
  type EventsOwner,
  type RefusedEvent,
  type SourceEvent,
} from "@we-the-rebel-alliance/source-contract/events"
import type { Clock, Ledger, LedgerEvent, RunRecord, RuntimeRecord } from "../ports.js"

/** The plugin's package name: every page names it, and cursors are bound to it. */
export const PACKAGE = "@joe-broadhead/opencode-colab"
/** The source's name, as `events_list`'s `source` input and every page name it. */
export const RUNS = "runs"
export const RUNS_ID = "colab.runs"
/** Every event's kind: the plugin's own, one finished run or job. */
export const RUN_KIND = "x-colab/run"
/** The descriptor's `maxBytes`: the most JSON one page holds. */
export const RUNS_MAX_BYTES = 131_072
/** What a page's envelope takes beside its events: source, account, owner, cursor, gap, flags. */
const ENVELOPE_BYTES = 4_096
const DAY = 86_400_000

export interface RunsCursor {
  /** The last sequence number the cursor covers. */
  readonly q: number
  /** The time of the entry at `q`, when the cursor saw it: a different time there means another ledger. */
  readonly h?: string
  /** The time history is covered up to: a gap's `since`. */
  readonly t: string
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/
const isIso = (value: unknown): value is string => typeof value === "string" && ISO.test(value) && !Number.isNaN(Date.parse(value))

export const runsBinding = (account: string): CursorBinding => ({ plugin: PACKAGE, source: RUNS, account })

export function encodeRunsCursor(account: string, state: RunsCursor): string {
  return encodeBoundCursor(runsBinding(account), { q: state.q, ...(state.h !== undefined ? { h: state.h } : {}), t: state.t })
}

/** The cursor's state, or CURSOR_INVALID for anything this source did not issue for this account. */
export function decodeRunsCursor(account: string, cursor: string): RunsCursor {
  const decoded = decodeBoundCursor(runsBinding(account), cursor)
  const state = decoded.ok ? decoded.state : undefined
  const q = state?.["q"]
  const h = state?.["h"]
  const t = state?.["t"]
  const keys = state ? Object.keys(state).filter((key) => key !== "q" && key !== "h" && key !== "t") : []
  if (!state || typeof q !== "number" || !Number.isSafeInteger(q) || q < 0 || !isIso(t) || (h !== undefined && !isIso(h)) || keys.length > 0) {
    throw new SourceError({
      code: "CURSOR_INVALID",
      what: `The cursor is not one colab.runs issued for the account ${account}`,
      next: "Call events_list again without a cursor, with since, to start over.",
    })
  }
  return { q, ...(h !== undefined ? { h } : {}), t }
}

/** What the source reads with: the ledger, the clock and how long the ledger keeps a run. */
export interface RunsDeps {
  readonly ledger: Ledger
  readonly clock: Clock
  readonly ledgerDays: number
}

/** A run whose end is recorded. `detached` is not final: the code may still be running and the plugin cannot see it. */
export const isFinal = (run: RunRecord): run is RunRecord & { readonly endedAt: string } =>
  run.state !== "running" && run.state !== "detached" && typeof run.endedAt === "string" && !Number.isNaN(Date.parse(run.endedAt))

/**
 * Whether a ledger entry announces this run: its id, its account, and appended after the run started. Strictly after:
 * package E settles a create that never landed (appending `run.finished`) and reopens the same id for the retry within
 * one commit, possibly in the same millisecond, and the settled attempt's entry must not announce the retry. A start
 * stamped by a clock ahead of the ledger's (a joined job's Google `createTime`) only delays the listing until the
 * ledger's clock passes it; the sweep's entries then announce it.
 */
export const announces = (entry: LedgerEvent, run: RunRecord): boolean =>
  entry.type === "run.finished" && entry.id === run.runId && entry.account === run.account && Date.parse(entry.at) > Date.parse(run.startedAt)

/**
 * The most entries one read's sweep appends. Each file-ledger append rewrites the log under the lock, so a backlog of
 * thousands would hold every writer for seconds (review #15, LOW 1); the rest are swept, and listed, by the next reads.
 */
export const SWEEP_MAX = 200

/**
 * Appends `run.finished` for final runs of `account` that no kept entry announces, ended within the ledger's
 * retention, oldest end first, at most that bound a read. Returns how many it appended.
 */
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

/** The last segment of a path or a resource name: a notebook's file name, a job's id. */
const lastSegment = (text: string) => text.split(/[\\/]/).filter(Boolean).at(-1) ?? text
const short = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/**
 * A finished run in the plugin's own words: what ran, where, how it ended (with the plugin's code) and for how long.
 * Never cell text, outputs, a traceback or anything a kernel printed; the notebook's file name is the person's own.
 */
export function titleOf(run: RunRecord & { readonly endedAt: string }, runtime?: RuntimeRecord): string {
  const took = duration(Date.parse(run.endedAt) - Date.parse(run.startedAt))
  const code = run.errorCode ? ` (${run.errorCode})` : ""
  const notebook = run.notebook ? short(lastSegment(run.notebook), 80) : undefined
  if (run.backend === "enterprise") {
    const job = short(lastSegment(run.job ?? run.runId), 64)
    return `Colab Enterprise job ${job}${notebook ? ` of ${notebook}` : ""} ${JOB_OUTCOME[run.state]}${code}, ${took}`
  }
  const where = short(run.spec ?? (runtime ? `${runtime.spec.accelerator === "NONE" ? "CPU" : runtime.spec.accelerator}` : "a Colab runtime"), 40)
  const what = notebook ? `${plural(run.cellIds.length, "cell")} of ${notebook}` : run.cellIds.length > 0 ? plural(run.cellIds.length, "cell") : "code"
  return `Ran ${what} on ${where} — ${OUTCOME[run.state]}${code}, ${took}`
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

/** One page of `colab.runs` for `account`, whose owner the caller has resolved. */
export async function listRuns(deps: RunsDeps, account: string, owner: EventsOwner, request: EventsListRequest): Promise<EventsListResult> {
  const from = request.cursor === undefined ? undefined : decodeRunsCursor(account, request.cursor)
  const now = deps.clock.now().getTime()

  // The log first, then the run records (review #15, M1): every writer records a run before its entry, so any entry this
  // read sees has its final record visible to the read of the records after it. Read the other way round, a run that
  // ended between the two reads would have its entry covered while its record still said running: skipped for good.
  let log = await deps.ledger.eventsSince(0, Number.MAX_SAFE_INTEGER)
  let runs = await deps.ledger.listRuns({ account })
  if ((await sweepFinished(deps, account, runs, log.events)) > 0) {
    // Other writers may have appended around the sweep's own entries: read both again, in the same order.
    log = await deps.ledger.eventsSince(0, Number.MAX_SAFE_INTEGER)
    runs = await deps.ledger.listRuns({ account })
  }

  const entries = log.events
  const oldest = log.oldest
  // The newest sequence number the ledger has issued: its last kept entry, or (all pruned) the one before the next.
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
    windowStart = startTime(request, now)
    t = new Date(windowStart).toISOString()
    q = oldest - 1
    // Entries were pruned (the oldest kept is not the first ever) and the window reaches past what the ledger keeps.
    if (oldest > 1 && windowStart < now - deps.ledgerDays * DAY) gap = { reason: "expired", since: t }
  }

  const records = new Map(runs.map((run) => [run.runId, run]))
  const runtimes = new Map((await deps.ledger.listRuntimes({ account })).map((runtime) => [runtime.id, runtime]))
  // The first kept entry that announces each record as it is now.
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
      // A full page stops before the next run it would list, so the cursor stays on the entry before it.
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
