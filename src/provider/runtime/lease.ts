/**
 * The per-runtime owner lease (review M5, LOW 1).
 *
 * The ledger is shared by every OpenCode process on the machine, and with `maxRuntimes: 1` two sessions using "the"
 * runtime is ordinary use. Without a lease the second process's socket reads as another client and the first probe
 * taints the runtime for good — an outage of exactly the kind the guarantee exists to prevent, caused by the plugin
 * itself. So a runtime has one owner process at a time:
 *
 * - the lease is a small JSON file beside the ledger, `{ pid, at, sessions }`, written once and refreshed by a
 *   heartbeat; a lease whose process is gone, or whose heartbeat is older than two minutes, is stale and claimable;
 * - a process that cannot claim refuses with `RUNTIME_BUSY` ("in use by another OpenCode process") and taints nothing;
 * - the same file remembers the session ids this runtime's owner created, which is what tells the plugin's own session
 *   from one another client opened under the copied nonce name (the nonce is public; see the guarantee's best-effort
 *   tier).
 *
 * With no ledger directory (a test's in-memory ledger) the lease is process-local, which is the same behaviour without
 * a second process to worry about.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export interface LeaseState {
  readonly pid: number
  /** When this owner last refreshed the lease, in epoch milliseconds. */
  readonly at: number
  /** Session name → the session id this owner created, so an adopted session can be checked. */
  readonly sessions: Readonly<Record<string, string>>
}

export interface Claim {
  readonly owner: boolean
  /** The other process's pid, when it holds the lease. */
  readonly holder?: number
}

export interface OwnerLease {
  claim(runtimeId: string): Promise<Claim>
  release(runtimeId: string): Promise<void>
  /** The session ids the current owner created on this runtime, by session name. */
  known(runtimeId: string): Promise<Readonly<Record<string, string>>>
  remember(runtimeId: string, name: string, id: string): Promise<void>
  forget(runtimeId: string): Promise<void>
  /** Stops every heartbeat this lease started; the files stay until they go stale. */
  dispose(): void
}

export interface OwnerLeaseOptions {
  /** `<ledger>/owners`; absent means process-local. */
  readonly dir?: string
  readonly pid?: number
  /** A lease older than this, or one whose process is gone, is claimable. */
  readonly staleMs?: number
  readonly heartbeatMs?: number
  readonly now?: () => number
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const alive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else; ESRCH means it is gone.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export function createOwnerLease(options: OwnerLeaseOptions = {}): OwnerLease {
  const pid = options.pid ?? process.pid
  const staleMs = options.staleMs ?? 120_000
  const heartbeatMs = options.heartbeatMs ?? 45_000
  const now = options.now ?? (() => Date.now())
  const memory = new Map<string, LeaseState>()
  const heartbeats = new Map<string, ReturnType<typeof setInterval>>()
  const fileOf = (runtimeId: string) => (options.dir && SAFE_ID.test(runtimeId) ? join(options.dir, `${runtimeId}.json`) : undefined)

  const read = (runtimeId: string): LeaseState | undefined => {
    const file = fileOf(runtimeId)
    if (!file) return memory.get(runtimeId)
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<LeaseState>
      if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return undefined
      return { pid: parsed.pid, at: parsed.at, sessions: parsed.sessions && typeof parsed.sessions === "object" ? (parsed.sessions as Record<string, string>) : {} }
    } catch {
      return undefined
    }
  }

  const write = (runtimeId: string, state: LeaseState) => {
    const file = fileOf(runtimeId)
    if (!file) {
      memory.set(runtimeId, state)
      return
    }
    mkdirSync(options.dir!, { recursive: true, mode: 0o700 })
    const temp = `${file}.${pid}.tmp`
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
    renameSync(temp, file)
  }

  const beat = (runtimeId: string) => {
    if (heartbeats.has(runtimeId)) return
    const timer = setInterval(() => {
      const state = read(runtimeId)
      if (!state || state.pid !== pid) {
        clearInterval(timer)
        heartbeats.delete(runtimeId)
        return
      }
      write(runtimeId, { ...state, at: now() })
    }, heartbeatMs)
    // A heartbeat must never keep the process alive, and must never fail a call.
    if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref(): void }).unref()
    heartbeats.set(runtimeId, timer)
  }

  const stop = (runtimeId: string) => {
    const timer = heartbeats.get(runtimeId)
    if (timer) clearInterval(timer)
    heartbeats.delete(runtimeId)
  }

  return {
    async claim(runtimeId: string) {
      const existing = read(runtimeId)
      if (existing && existing.pid !== pid && alive(existing.pid) && now() - existing.at < staleMs) {
        return { owner: false, holder: existing.pid }
      }
      const previous = existing?.pid === pid ? existing : { pid, at: now(), sessions: {} }
      write(runtimeId, { ...previous, pid, at: now() })
      beat(runtimeId)
      return { owner: true }
    },

    async release(runtimeId: string) {
      stop(runtimeId)
      const existing = read(runtimeId)
      if (!existing || existing.pid !== pid) return
      const file = fileOf(runtimeId)
      if (file) rmSync(file, { force: true })
      else memory.delete(runtimeId)
    },

    async known(runtimeId: string) {
      const state = read(runtimeId)
      return state?.pid === pid ? state.sessions : {}
    },

    async remember(runtimeId: string, name: string, id: string) {
      const state = read(runtimeId)
      const base = state?.pid === pid ? state : { pid, at: now(), sessions: {} }
      write(runtimeId, { ...base, sessions: { ...base.sessions, [name]: id } })
    },

    async forget(runtimeId: string) {
      const state = read(runtimeId)
      if (!state || state.pid !== pid) return
      write(runtimeId, { ...state, sessions: {} })
    },

    dispose() {
      for (const timer of heartbeats.values()) clearInterval(timer)
      heartbeats.clear()
    },
  }
}
