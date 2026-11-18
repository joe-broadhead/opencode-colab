/**
 * The run ledger (design §5): `$XDG_STATE_HOME/opencode-colab/ledger/`, one JSON file per runtime (`runtimes/`) and
 * per run (`runs/`), written copy-on-write (a temp file, then rename), plus `events.jsonl`, all under one
 * cross-process lock, pruned after `ledgerDays`. Files are 0600 and folders 0700. It never holds cell text, tokens or
 * runtime URLs. The ledger is the truth about which runtimes are the plugin's own (design §7.4 step 1).
 */
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
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

  private appendLocked(event: Omit<LedgerEvent, "seq" | "at">): LedgerEvent {
    // The log is written before meta.json, so a crash between the two leaves nextSeq behind: never reuse a number.
    const seq = Math.max(this.readMeta().nextSeq, (this.readEvents().at(-1)?.seq ?? 0) + 1)
    const meta = { nextSeq: seq }
    const full: LedgerEvent = { ...event, seq: meta.nextSeq, at: this.clock.now().toISOString() }
    const path = join(this.dir, "events.jsonl")
    const before = existsSync(path) ? readFileSync(path, "utf8") : ""
    // Copy-on-write for the log too: a crash leaves the old log or the new one, never half a line.
    this.writeText(path, `${before}${JSON.stringify(full)}\n`)
    this.writeJson(join(this.dir, "meta.json"), { nextSeq: meta.nextSeq + 1 })
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

/** A run is final once it has ended in a state that is neither running nor detached. */
export function isFinal(run: RunRecord): boolean {
  return run.state !== "running" && run.state !== "detached" && run.endedAt !== undefined
}

/** Ids become file names, so they are held to a safe shape. */
function checkId(id: string): string {
  if (!SAFE_ID.test(id)) throw new ColabError("NOT_FOUND", "The id has characters a ledger record cannot have.")
  return id
}
