/**
 * The run ledger (design §5): `$XDG_STATE_HOME/opencode-colab/ledger/`, one JSON file per runtime (`runtimes/`) and
 * per run (`runs/`), written copy-on-write (a temp file, then rename), plus `events.jsonl`, appended to in constant
 * time (only its tail is read; pruning rewrites it copy-on-write), all under one
 * cross-process lock, pruned after `ledgerDays`. Files are 0600 and folders 0700. It never holds cell text, tokens or
 * runtime URLs. The ledger is the truth about which runtimes are the plugin's own (design §7.4 step 1).
 */
import { randomBytes } from "node:crypto"
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { ColabError } from "../domain/errors.js"
import type { Clock, Ledger, LedgerEvent, RunRecord, RuntimeRecord, Taint } from "../ports.js"

/** The ledger folder for an environment: `$XDG_STATE_HOME/opencode-colab/ledger`, or `~/.local/state/…`. */
export function ledgerDir(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME && env.XDG_STATE_HOME.startsWith("/") ? env.XDG_STATE_HOME : join(homedir(), ".local", "state")
  return join(state, "opencode-colab", "ledger")
}

export interface LedgerOptions {
  readonly ledgerDays: number
  readonly clock?: Clock
  /** How long to wait for the lock before LEDGER_UNAVAILABLE. */
  readonly lockTimeoutMs?: number
  /** A lock older than this whose owner is gone is broken. */
  readonly staleLockMs?: number
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export class FileLedger implements Ledger {
  private readonly clock: Clock
  private readonly lockTimeoutMs: number
  private readonly staleLockMs: number

  constructor(
    readonly dir: string,
    private readonly options: LedgerOptions,
  ) {
    this.clock = options.clock ?? { now: () => new Date() }
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000
    this.staleLockMs = options.staleLockMs ?? 30_000
  }

  async putRuntime(record: RuntimeRecord): Promise<void> {
    await this.locked(() => this.writeJson(join(this.folder("runtimes"), `${checkId(record.id)}.json`), record))
  }

  async getRuntime(id: string): Promise<RuntimeRecord | undefined> {
    return this.readJson<RuntimeRecord>(join(this.folder("runtimes"), `${checkId(id)}.json`))
  }

  async listRuntimes(filter: { readonly account?: string; readonly live?: boolean } = {}): Promise<readonly RuntimeRecord[]> {
    return this.readAll<RuntimeRecord>("runtimes").filter(
      (record) => (filter.account === undefined || record.account === filter.account) && (!filter.live || record.state === "creating" || record.state === "ready"),
    )
  }

  async taint(id: string, taint: Taint): Promise<RuntimeRecord | undefined> {
    return this.locked(() => {
      const path = join(this.folder("runtimes"), `${checkId(id)}.json`)
      const record = this.readJson<RuntimeRecord>(path)
      if (!record) return undefined
      if (record.tainted) return record
      const next: RuntimeRecord = { ...record, tainted: taint }
      this.writeJson(path, next)
      this.appendLocked({ type: "runtime.tainted", id: record.id, account: record.account })
      return next
    })
  }

  /**
   * Writes the run, and in the same locked section appends `run.finished` when this write makes it final and the
   * previous record was absent or not final (colab-15 request 5): one entry per transition to final, none for a
   * rewrite of a final record, and one again after a reopen. A reader that sees the entry sees the final record too.
   */
  async putRun(record: RunRecord): Promise<void> {
    await this.locked(() => {
      const path = join(this.folder("runs"), `${checkId(record.runId)}.json`)
      const previous = this.readJson<RunRecord>(path)
      this.writeJson(path, record)
      if (isFinal(record) && (previous === undefined || !isFinal(previous))) this.appendLocked({ type: "run.finished", id: record.runId, account: record.account })
    })
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    return this.readJson<RunRecord>(join(this.folder("runs"), `${checkId(runId)}.json`))
  }

  async listRuns(filter: { readonly account?: string; readonly since?: string; readonly state?: RunRecord["state"] } = {}): Promise<readonly RunRecord[]> {
    return this.readAll<RunRecord>("runs")
      .filter((run) => (filter.account === undefined || run.account === filter.account) && (filter.state === undefined || run.state === filter.state) && (filter.since === undefined || run.startedAt >= filter.since))
      .sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : 0))
  }

  async append(event: Omit<LedgerEvent, "seq" | "at">): Promise<LedgerEvent> {
    return this.locked(() => this.appendLocked(event))
  }

  async eventsSince(seq: number, limit: number): Promise<{ readonly events: readonly LedgerEvent[]; readonly expired: boolean; readonly oldest: number }> {
    const all = this.readEvents()
    const next = this.readMeta().nextSeq
    const oldest = all[0]?.seq ?? next
    return { events: all.filter((event) => event.seq > seq).slice(0, Math.max(0, limit)), expired: seq < oldest - 1, oldest }
  }

  async prune(now: Date): Promise<number> {
    const cutoff = new Date(now.getTime() - this.options.ledgerDays * 86_400_000).toISOString()
    return this.locked(() => {
      let removed = 0
      for (const record of this.readAll<RuntimeRecord>("runtimes")) {
        const ended = record.state === "released" || record.state === "gone"
        if (ended && (record.releasedAt ?? record.createdAt) < cutoff) {
          rmSync(join(this.folder("runtimes"), `${checkId(record.id)}.json`), { force: true })
          removed++
        }
      }
      for (const run of this.readAll<RunRecord>("runs")) {
        if (run.state !== "running" && (run.endedAt ?? run.startedAt) < cutoff) {
          rmSync(join(this.folder("runs"), `${checkId(run.runId)}.json`), { force: true })
          removed++
        }
      }
      const kept = this.readEvents().filter((event) => event.at >= cutoff)
      this.writeText(join(this.dir, "events.jsonl"), kept.map((event) => `${JSON.stringify(event)}\n`).join(""))
      return removed
    })
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Appends one event in constant time, whatever the log's length (colab-16 LOW 6, colab-15 LOW 1): the log is opened
   * for append and only its tail is read, never the whole file.
   *
   * - **Its number, never one already used.** `meta.json` (`nextSeq: seq + 1`) is written **before** the line, so a
   *   crash between the two leaves a gap in the numbers, never a reuse; a reader's cursor passes a gap harmlessly
   *   (colab-17 LOW 1). The number is `max(meta.nextSeq, last parseable line's seq + 1)`, so a log a version before
   *   this one left with `meta.json` behind is still numbered past its last event.
   * - **A torn line.** A crash inside the append can leave the last line unterminated. Readers skip a line that does
   *   not parse, and the next append starts on a new line, so the torn line never swallows a real event. A last line
   *   that parses although its newline is missing is a real event, and its number counts.
   */
  private appendLocked(event: Omit<LedgerEvent, "seq" | "at">): LedgerEvent {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const path = join(this.dir, "events.jsonl")
    const tail = readTail(path)
    const seq = Math.max(this.readMeta().nextSeq, (tail.lastSeq ?? 0) + 1)
    const full: LedgerEvent = { ...event, seq, at: this.clock.now().toISOString() }
    this.writeJson(join(this.dir, "meta.json"), { nextSeq: seq + 1 })
    try {
      appendFileSync(path, `${tail.endsWithNewline ? "" : "\n"}${JSON.stringify(full)}\n`, { mode: 0o600 })
    } catch {
      throw new ColabError("LEDGER_UNAVAILABLE", "The ledger's event log could not be written.")
    }
    return full
  }

  private readMeta(): { nextSeq: number } {
    return this.readJson<{ nextSeq: number }>(join(this.dir, "meta.json")) ?? { nextSeq: 1 }
  }

  private readEvents(): LedgerEvent[] {
    const path = join(this.dir, "events.jsonl")
    if (!existsSync(path)) return []
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEvent]
        } catch {
          return []
        }
      })
  }

  private folder(name: "runtimes" | "runs"): string {
    const path = join(this.dir, name)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return path
  }

  private readAll<T>(name: "runtimes" | "runs"): T[] {
    const folder = this.folder(name)
    return readdirSync(folder)
      .filter((file) => file.endsWith(".json"))
      .flatMap((file) => {
        const value = this.readJson<T>(join(folder, file))
        return value === undefined ? [] : [value]
      })
  }

  private readJson<T>(path: string): T | undefined {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      if (error instanceof SyntaxError) return undefined
      throw new ColabError("LEDGER_UNAVAILABLE", "A ledger file could not be read.")
    }
  }

  private writeJson(path: string, value: unknown): void {
    this.writeText(path, `${JSON.stringify(value)}\n`)
  }

  private writeText(path: string, text: string): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const temp = `${path}.tmp-${randomBytes(6).toString("hex")}`
    try {
      writeFileSync(temp, text, { mode: 0o600 })
      renameSync(temp, path)
    } catch {
      rmSync(temp, { force: true })
      throw new ColabError("LEDGER_UNAVAILABLE", "A ledger file could not be written.")
    }
  }

  /** A cross-process lock: an exclusive `lock` folder holding its owner's pid; a stale one whose owner is gone is broken. */
  private async locked<T>(work: () => T): Promise<T> {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    const lock = join(this.dir, "lock")
    const deadline = Date.now() + this.lockTimeoutMs
    for (let wait = 5; ; wait = Math.min(wait * 2, 100)) {
      try {
        mkdirSync(lock, { mode: 0o700 })
        writeFileSync(join(lock, "owner"), String(process.pid))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new ColabError("LEDGER_UNAVAILABLE", "The ledger lock could not be taken.")
        if (this.isStale(lock)) {
          rmSync(lock, { recursive: true, force: true })
          continue
        }
        if (Date.now() > deadline) throw new ColabError("LEDGER_UNAVAILABLE", "The ledger lock was not released in time.")
        await new Promise((resolve) => setTimeout(resolve, wait))
      }
    }
    try {
      return work()
    } finally {
      rmSync(lock, { recursive: true, force: true })
    }
  }

  private isStale(lock: string): boolean {
    try {
      const age = Date.now() - statSync(lock).mtimeMs
      if (age < this.staleLockMs) return false
      const pid = Number(readFileSync(join(lock, "owner"), "utf8"))
      if (!Number.isInteger(pid) || pid <= 0) return true
      try {
        process.kill(pid, 0)
        return false
      } catch {
        return true
      }
    } catch {
      return false
    }
  }
}

/** The bytes `readTail` reads first; it doubles the window until it holds a whole last line. */
const TAIL_WINDOW = 4096

/**
 * The seq of the log's last line that parses, read from the end in a window that starts at 4 KiB and doubles while it
 * holds no parseable whole line, so it walks back past every torn or unparseable line (colab-17 LOW 1), bounded by the
 * file's size; and whether the file ends with a newline (an empty or missing log does). In the usual case it reads one
 * window: the last line or two, never the whole log.
 */
export function readTail(path: string): { readonly lastSeq?: number; readonly endsWithNewline: boolean } {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { endsWithNewline: true }
    throw new ColabError("LEDGER_UNAVAILABLE", "The ledger's event log could not be read.")
  }
  try {
    const size = fstatSync(fd).size
    if (size === 0) return { endsWithNewline: true }
    let endsWithNewline = true
    for (let window = TAIL_WINDOW; ; window *= 2) {
      const length = Math.min(window, size)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      const text = buffer.toString("utf8")
      if (window === TAIL_WINDOW) endsWithNewline = text.endsWith("\n")
      const lines = text.split("\n")
      // Unless the window reaches the file's start, its first piece may be the end of a longer line: never trust it.
      const whole = length < size ? lines.slice(1) : lines
      for (let index = whole.length - 1; index >= 0; index--) {
        const seq = parsedSeq(whole[index]!)
        if (seq !== undefined) return { lastSeq: seq, endsWithNewline }
      }
      if (length === size) return { endsWithNewline }
    }
  } finally {
    closeSync(fd)
  }
}

function parsedSeq(line: string): number | undefined {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown }).seq
    return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined
  } catch {
    return undefined
  }
}

/**
 * A run is final once it has ended in a state that is neither running nor detached, at a time that parses. The one
 * definition `putRun`'s announcement and the `colab.runs` source share (colab-16, LOW 4): a record with an unparsable
 * `endedAt` is announced by neither, and listed by neither.
 */
export function isFinal(run: RunRecord): run is RunRecord & { readonly endedAt: string } {
  return run.state !== "running" && run.state !== "detached" && typeof run.endedAt === "string" && !Number.isNaN(Date.parse(run.endedAt))
}

/** Ids become file names, so they are held to a safe shape. */
function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new ColabError("NOT_FOUND", "The id has characters a ledger record cannot have.")
  return id
}
