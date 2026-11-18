/**
 * A strict in-memory ledger for the `colab.runs` source's tests, with the file ledger's own rules
 * (src/ledger/store.ts), so a long simulation runs in memory and still means what it means on disk:
 *
 * - `append` assigns the next sequence number and the clock's time, as `appendLocked` does under the lock;
 * - `eventsSince(seq)` answers the entries after `seq`, `oldest` (the first kept entry's number, or the next number when
 *   none is kept) and `expired` exactly when `seq < oldest - 1`;
 * - `prune(now)` drops entries older than `ledgerDays` and finished runs whose end is older, as the file ledger does;
 * - `listRuns` answers by `startedAt`, as the file ledger sorts.
 *
 * Unlike Day 0's `MemoryLedger` (which keeps runs on prune and prunes at a fixed 90 days), it prunes runs with
 * `ledgerDays`, can be wiped (`reset`, a deleted state folder), refuses an id the file ledger would refuse, and counts
 * every read so a test can bound the reads a page makes. test/unit/sources-runs.test.ts runs the same scenarios on the
 * file ledger itself.
 */
import { ColabError } from "../../src/domain/errors.js"
import type { Clock, Ledger, LedgerEvent, RunRecord, RuntimeRecord, Taint } from "../../src/ports.js"

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const checkId = (id: string) => {
  if (!SAFE_ID.test(id)) throw new ColabError("NOT_FOUND", "The id has characters a ledger record cannot have.")
  return id
}

export class SourcesLedger implements Ledger {
  readonly runtimes = new Map<string, RuntimeRecord>()
  readonly runs = new Map<string, RunRecord>()
  events: LedgerEvent[] = []
  private nextSeq = 1
  /** Reads by method, so a test can bound what one page costs. */
  readonly reads = { listRuns: 0, eventsSince: 0, listRuntimes: 0, append: 0 }

  constructor(
    private readonly clock: Clock,
    private readonly ledgerDays = 90,
  ) {}

  async putRuntime(record: RuntimeRecord) {
    this.runtimes.set(checkId(record.id), structuredClone(record))
  }
  async getRuntime(id: string) {
    const record = this.runtimes.get(checkId(id))
    return record && structuredClone(record)
  }
  async listRuntimes(filter: { account?: string; live?: boolean } = {}) {
    this.reads.listRuntimes++
    return [...this.runtimes.values()]
      .filter((record) => (filter.account === undefined || record.account === filter.account) && (!filter.live || record.state === "creating" || record.state === "ready"))
      .map((record) => structuredClone(record))
  }
  async taint(id: string, taint: Taint) {
    const record = this.runtimes.get(checkId(id))
    if (!record || record.tainted) return record
    const next = { ...record, tainted: taint }
    this.runtimes.set(id, next)
    await this.append({ type: "runtime.tainted", id, account: record.account })
    return next
  }
  async putRun(record: RunRecord) {
    this.runs.set(checkId(record.runId), structuredClone(record))
  }
  async getRun(runId: string) {
    const run = this.runs.get(checkId(runId))
    return run && structuredClone(run)
  }
  async listRuns(filter: { account?: string; since?: string; state?: RunRecord["state"] } = {}) {
    this.reads.listRuns++
    return [...this.runs.values()]
      .filter((run) => (filter.account === undefined || run.account === filter.account) && (filter.state === undefined || run.state === filter.state) && (filter.since === undefined || run.startedAt >= filter.since))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
      .map((run) => ({ ...run }))
  }
  async append(event: Omit<LedgerEvent, "seq" | "at">) {
    this.reads.append++
    const full: LedgerEvent = { ...event, seq: this.nextSeq++, at: this.clock.now().toISOString() }
    this.events.push(full)
    return { ...full }
  }
  async eventsSince(seq: number, limit: number) {
    this.reads.eventsSince++
    const oldest = this.events[0]?.seq ?? this.nextSeq
    return { events: this.events.filter((event) => event.seq > seq).slice(0, Math.max(0, limit)).map((event) => ({ ...event })), expired: seq < oldest - 1, oldest }
  }
  async prune(now: Date) {
    const cutoff = new Date(now.getTime() - this.ledgerDays * 86_400_000).toISOString()
    let removed = 0
    for (const run of [...this.runs.values()]) {
      if (run.state !== "running" && (run.endedAt ?? run.startedAt) < cutoff) {
        this.runs.delete(run.runId)
        removed++
      }
    }
    this.events = this.events.filter((event) => event.at >= cutoff)
    return removed
  }
  /** The state folder deleted: every record and entry gone, numbering from 1 again. */
  reset() {
    this.runtimes.clear()
    this.runs.clear()
    this.events = []
    this.nextSeq = 1
  }
}
