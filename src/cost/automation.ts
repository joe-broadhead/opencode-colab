/**
 * The plugin's automation (design §8.3): every 60 s, for consumer runtimes of ours that are not tainted and not held
 * by another OpenCode process, apply the Jupyter idle rule and harvest-then-release. It is not a tool call, so it
 * cannot ask; it follows the person's choice instead (design §8.3 step 4, boxd §C.3 step 6):
 *
 * - `access: "all"` (the default): on;
 * - `access: "ask-changes"` and `"read-only"`: off (`off (access)`), unless the person set `automation: "on"` — their
 *   standing yes, at any access level;
 * - `automation: "off"`: off.
 *
 * One automation owner per machine, as boxd does: a heartbeat lock beside the ledger, `<ledger>/automation/lock`, taken
 * with an atomic `mkdir`, refreshed every 30 s and stale after two minutes. A second OpenCode process reports
 * `not-owner` and runs nothing, so a runtime is never released twice.
 *
 * Enterprise runtimes are never touched: there is no idle signal, and a stop loses kernel memory (design §8.3 step 3).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Access } from "../constants.js"
import type { Deps } from "../deps.js"
import type { Ledger, Release } from "../ports.js"
import { closeRecord } from "./release.js"
import { idleRuleOf, readIdle, type IdleRule, type IdleVerdict } from "./idle.js"

export type AutomationState = "on" | "on (consent)" | "off" | "off (access)" | "not-owner"

export interface AutomationChoice {
  readonly automation: "auto" | "on" | "off"
  readonly access: Access
  /** False while another process holds the automation lock. */
  readonly owner: boolean
}

/** The state status, the context line and `/colab-cleanup` report (design §8.3 step 4). */
export function automationState(choice: AutomationChoice): AutomationState {
  if (choice.automation === "off") return "off"
  if (choice.automation === "on") return choice.owner ? "on (consent)" : "not-owner"
  if (choice.access !== "all") return "off (access)"
  return choice.owner ? "on" : "not-owner"
}

/** Whether this process runs the loop: the two "on" states and no other. */
export const automationRuns = (state: AutomationState): boolean => state === "on" || state === "on (consent)"

const alive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

export interface AutomationLock {
  /** Takes the lock if it is free or stale; false when another live process owns it. */
  claim(): boolean
  heartbeat(): void
  release(): void
  readonly owner: boolean
}

export interface AutomationLockOptions {
  readonly pid?: number
  readonly now?: () => number
  readonly staleMs?: number
  /** A test's process table: by default the real one, where a pid that is gone makes the lock stale. */
  readonly alive?: (pid: number) => boolean
}

/**
 * The heartbeat lock: a folder taken with `mkdir` (atomic across processes), holding `state.json` `{ pid, at }`.
 * No ledger directory (a test's in-memory ledger) means this process is the owner, as B's lease does.
 */
export function createAutomationLock(dir: string | undefined, options: AutomationLockOptions = {}): AutomationLock {
  const pid = options.pid ?? process.pid
  const now = options.now ?? (() => Date.now())
  const staleMs = options.staleMs ?? 120_000
  const processAlive = options.alive ?? alive
  let owned = dir === undefined

  const path = dir === undefined ? undefined : join(dir, "automation", "lock")
  const statePath = path === undefined ? undefined : join(path, "state.json")

  const read = (): { pid: number; at: number } | undefined => {
    if (statePath === undefined) return undefined
    try {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { pid?: unknown; at?: unknown }
      if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return undefined
      return { pid: parsed.pid, at: parsed.at }
    } catch {
      return undefined
    }
  }

  const writeState = () => {
    if (path === undefined || statePath === undefined) return
    mkdirSync(path, { recursive: true, mode: 0o700 })
    writeFileSync(statePath, JSON.stringify({ pid, at: now() }), { mode: 0o600 })
  }

  return {
    get owner() {
      return owned
    },
    claim() {
      if (dir === undefined) return (owned = true)
      // The parent is created once; the lock itself is taken with a plain `mkdir`, which is atomic across processes.
      mkdirSync(join(dir, "automation"), { recursive: true, mode: 0o700 })
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          mkdirSync(path!, { recursive: false, mode: 0o700 })
          writeState()
          return (owned = true)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") return (owned = false)
          const state = read()
          if (state?.pid === pid) {
            writeState()
            return (owned = true)
          }
          const held = state !== undefined && state.pid !== pid && processAlive(state.pid) && now() - state.at < staleMs
          if (held) return (owned = false)
          rmSync(path!, { recursive: true, force: true })
        }
      }
      return (owned = false)
    },
    heartbeat() {
      if (!owned || dir === undefined) return
      const state = read()
      if (state !== undefined && state.pid !== pid) {
        owned = false
        return
      }
      writeState()
    },
    release() {
      if (!owned || dir === undefined) return
      const state = read()
      if (state !== undefined && state.pid === pid) rmSync(path!, { recursive: true, force: true })
      owned = false
    },
  }
}

export interface AutomationInput {
  readonly options: Pick<Deps["options"], "autoReleaseMinutes" | "maxRuntimeHours" | "ledgerDays">
  readonly ledger: Ledger
  readonly runtime: Deps["runtime"]
  readonly colab: Pick<Deps["colab"], "getRuntime">
  readonly release: Pick<Release, "release">
  readonly now: Date
  readonly signal: AbortSignal
}

export interface AutomationOutcome {
  readonly released: readonly { readonly id: string; readonly reason: "idle" | "lifetime"; readonly harvested: number }[]
  /** Runtimes left alone, with the plugin's own words only: no token, URL or Google text (design §7.3). */
  readonly attention: readonly string[]
}

/** One whole sweep: the same function the loop runs every 60 s, so a test drives it without timers. */
export async function runAutomationOnce(input: AutomationInput): Promise<AutomationOutcome> {
  const released: { id: string; reason: "idle" | "lifetime"; harvested: number }[] = []
  const attention: string[] = []
  const records = await input.ledger.listRuntimes({ live: true })
  const rule: IdleRule = { autoReleaseMinutes: input.options.autoReleaseMinutes, maxHours: input.options.maxRuntimeHours }

  for (const record of records) {
    if (record.backend !== "colab") continue
    let running = 0
    try {
      running = (await input.ledger.listRuns({ account: record.account, state: "running" })).filter((run) => run.runtime === record.id).length
    } catch {
      attention.push(`Runtime ${record.id}: the ledger could not be read, so it was left alone.`)
      continue
    }
    let verdict: IdleVerdict
    try {
      verdict = await readIdle({
        record,
        kernels: (account, runtimeId) => input.runtime.kernels({ account, runtimeId }, input.signal),
        sessions: (account, runtimeId) => input.runtime.sessions({ account, runtimeId }, input.signal),
        get: (account, runtimeId) => input.colab.getRuntime(account, runtimeId, input.signal),
        activeRuns: running,
        rule: idleRuleOf(record, rule),
        now: input.now,
      })
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      attention.push(`Runtime ${record.id}: its state could not be read, so it was left alone.`)
      continue
    }

    if (verdict.state === "gone") {
      const closed = await closeRecord(input.ledger, record, "gone", input.now.toISOString()).then(() => true, () => false)
      attention.push(`Runtime ${record.id}: it has ended, so its ledger record ${closed ? "was closed" : "could not be closed"}.`)
      continue
    }
    if (verdict.state === "blocked") {
      if (verdict.why === "unreadable" || verdict.why === "tainted") {
        const why =
          verdict.why === "tainted"
            ? "it is tainted, so it is released only by plan"
            : verdict.code === "RUNTIME_BUSY"
              ? "another OpenCode process is using it"
              : `its state could not be read (${verdict.code ?? "unreadable"})`
        attention.push(`Runtime ${record.id}: ${why}; it was left alone.`)
      }
      continue
    }

    try {
      const answer = await input.release.release(record, { reason: verdict.reason, force: false }, input.signal)
      if (answer.released) released.push({ id: record.id, reason: verdict.reason, harvested: answer.harvested.length })
      else if (answer.warnings.includes("UNHARVESTED")) attention.push(`Runtime ${record.id}: its keep paths could not be harvested, so its release is blocked.`)
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error
      attention.push(`Runtime ${record.id}: the release could not be completed; it was left alone.`)
    }
  }
  return { released, attention }
}

export interface AutomationLoop {
  /** The state to report right now (the lock is claimed at start and on a failed claim retried each tick). */
  state(): AutomationState
  /** One sweep now, as the interval runs it. */
  tick(): Promise<AutomationOutcome | undefined>
  dispose(): Promise<void>
}

export interface AutomationEnvironment {
  readonly options: Deps["options"]
  readonly ledger: Ledger
  readonly runtime: Deps["runtime"]
  readonly colab: Pick<Deps["colab"], "getRuntime">
  readonly release: Pick<Release, "release">
  readonly clock: Pick<Deps["clock"], "now">
  /** `<ledger>/owners`' neighbour: `<ledger>/automation`; absent for an in-memory ledger. */
  readonly lockDir?: string
  readonly intervalMs?: number
}

/** The loop: claim, sweep every 60 s, heartbeat, and give the lock back on dispose. */
export function createAutomationLoop(env: AutomationEnvironment): AutomationLoop {
  const lock = createAutomationLock(env.lockDir)
  const controller = new AbortController()
  let ticking = false
  let timer: ReturnType<typeof setInterval> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let disposed = false

  // A process that cannot run the loop never takes the lock: at ask-changes or read-only it would block the process
  // the person did consent through, and status already says why it does not act.
  const couldRun = () => env.options.automation === "on" || (env.options.automation === "auto" && env.options.access === "all")
  const state = (): AutomationState =>
    automationState({ automation: env.options.automation, access: env.options.access, owner: couldRun() && !disposed ? lock.claim() : false })

  const tick = async (): Promise<AutomationOutcome | undefined> => {
    if (disposed || ticking) return undefined
    if (!automationRuns(state())) return undefined
    ticking = true
    try {
      return await runAutomationOnce({
        options: env.options,
        ledger: env.ledger,
        runtime: env.runtime,
        colab: env.colab,
        release: env.release,
        now: env.clock.now(),
        signal: controller.signal,
      })
    } finally {
      ticking = false
    }
  }

  if (couldRun()) {
    const interval = env.intervalMs ?? 60_000
    lock.claim()
    timer = setInterval(() => void tick().catch(() => undefined), interval)
    heartbeat = setInterval(() => lock.heartbeat(), Math.min(30_000, interval))
    for (const handle of [timer, heartbeat]) if (typeof handle === "object" && handle !== null && "unref" in handle) (handle as { unref(): void }).unref()
    void tick().catch(() => undefined)
  }

  return {
    state,
    tick,
    async dispose() {
      disposed = true
      controller.abort()
      if (timer) clearInterval(timer)
      if (heartbeat) clearInterval(heartbeat)
      lock.release()
    },
  }
}

/** The ledger's own folder (the lock lives at `<ledger>/automation/lock`); `undefined` for a test's memory ledger. */
export function ledgerBase(ledger: object): string | undefined {
  const dir = (ledger as { readonly dir?: string }).dir
  return typeof dir === "string" ? dir : undefined
}

/**
 * Who owns the automation right now, without claiming anything: a read for status and the cost block. No lock file, or
 * one whose process is gone or stale, means this process would own it.
 */
export function automationOwner(dir: string | undefined, now: () => number = Date.now, pid = process.pid): { readonly owner: boolean; readonly holder?: number } {
  if (dir === undefined) return { owner: true }
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "automation", "lock", "state.json"), "utf8")) as { pid?: unknown; at?: unknown }
    if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return { owner: true }
    if (parsed.pid === pid) return { owner: true }
    const held = alive(parsed.pid) && now() - parsed.at < 120_000
    return held ? { owner: false, holder: parsed.pid } : { owner: true }
  } catch {
    return { owner: true }
  }
}
