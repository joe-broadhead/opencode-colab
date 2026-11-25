/**
 * The Jupyter idle rule (design §8.3 step 1): idle comes from Jupyter, never from the plugin's own clock alone.
 *
 * A consumer runtime of ours is idle when:
 *
 * - every kernel reports `execution_state: "idle"` — any other state (`busy`, `starting`, `dead`, or a value a later
 *   Jupyter adds) blocks, because the plugin never releases what it does not understand;
 * - no session but the plugin's own is open: every `/api/sessions` name starts `oc-<nonce>-` (the nonce is public; a
 *   session without it is foreign, design §5);
 * - no kernel connection but the plugin's own: `connections` is at most the calibrated baseline plus one per session
 *   of ours on that kernel;
 * - no run of ours is active;
 * - and the newest `last_activity` is older than `autoReleaseMinutes` (reason `idle`), or the runtime is older than
 *   `maxRuntimeHours` with all of the above still true (reason `lifetime`, for a `last_activity` Jupyter never moved).
 *
 * Shapes: Jupyter Server's REST API (https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html, design
 * §18 [19]) — `/api/kernels` gives `execution_state`, `last_activity` and `connections`; `/api/sessions` gives
 * `{ id, name, path, kernel }`.
 */
import { ColabError, type ErrorCode } from "../../domain/errors.js"
import type { KernelInfo, RuntimeRecord, SessionInfo } from "../ports.js"

export type IdleBlocker = "kernel-not-idle" | "recent-activity" | "foreign-session" | "extra-connection" | "active-run" | "tainted" | "not-ready" | "unreadable"

export type IdleVerdict =
  | {
      readonly state: "idle"
      /** `idle` when Jupyter's activity passed `autoReleaseMinutes`; `lifetime` when only the age bound did. */
      readonly reason: "idle" | "lifetime"
      readonly lastActivity: string
      readonly idleMinutes: number
      readonly ageHours: number
    }
  | { readonly state: "blocked"; readonly why: IdleBlocker; readonly code?: ErrorCode }
  | { readonly state: "gone"; readonly message: string }

export interface IdleRule {
  readonly autoReleaseMinutes: number
  readonly maxHours: number
}

/** The rule for one runtime, from its ledger record: shown at creation and used by the automation. */
export const idleRuleOf = (record: Pick<RuntimeRecord, "lease" | "createdAt">, options: IdleRule): IdleRule => ({
  autoReleaseMinutes: record.lease?.releaseAfterIdleMinutes ?? options.autoReleaseMinutes,
  maxHours: record.lease?.maxHours ?? options.maxHours,
})

export interface IdleInput {
  readonly record: Pick<RuntimeRecord, "createdAt" | "nonce" | "tainted" | "state" | "calibration">
  readonly kernels: readonly KernelInfo[]
  readonly sessions: readonly SessionInfo[]
  /** Runs of ours in `state: "running"` on this runtime. */
  readonly activeRuns: number
  readonly rule: IdleRule
  readonly now: Date
}

export function idleVerdict(input: IdleInput): IdleVerdict {
  const { record, kernels, sessions, rule, now } = input
  if (record.state !== "ready") return { state: "blocked", why: "not-ready" }
  if (record.tainted) return { state: "blocked", why: "tainted" }
  if (input.activeRuns > 0) return { state: "blocked", why: "active-run" }

  const ourSession = (session: SessionInfo) => session.name.startsWith(`oc-${record.nonce}-`)
  if (sessions.some((session) => !ourSession(session))) return { state: "blocked", why: "foreign-session" }

  const baseline = record.calibration?.baselineConnections ?? {}
  for (const kernel of kernels) {
    if (kernel.executionState !== "idle") return { state: "blocked", why: "kernel-not-idle" }
    const ours = sessions.filter((session) => session.kernelId === kernel.id && ourSession(session)).length
    const base = baseline[kernel.id] ?? 0
    if (kernel.connections > base + ours) return { state: "blocked", why: "extra-connection" }
  }

  const created = Date.parse(record.createdAt)
  if (!Number.isFinite(created)) return { state: "gone", message: "The runtime's ledger record has no usable creation time." }
  // Jupyter moves `last_activity` only while it can; with no kernel yet, the runtime's own age is the activity.
  const activity = kernels
    .map((kernel) => Date.parse(kernel.lastActivity))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0]
  const last = activity ?? created
  const idleMinutes = Math.max(0, (now.getTime() - last) / 60_000)
  const ageHours = Math.max(0, (now.getTime() - created) / 3_600_000)

  if (idleMinutes >= rule.autoReleaseMinutes) return { state: "idle", reason: "idle", lastActivity: new Date(last).toISOString(), idleMinutes, ageHours }
  if (ageHours >= rule.maxHours) return { state: "idle", reason: "lifetime", lastActivity: new Date(last).toISOString(), idleMinutes, ageHours }
  return { state: "blocked", why: "recent-activity" }
}

export interface ReadIdleInput {
  readonly record: RuntimeRecord
  readonly kernels: (account: string, runtimeId: string) => Promise<readonly KernelInfo[]>
  readonly sessions: (account: string, runtimeId: string) => Promise<readonly SessionInfo[]>
  /** `runtimes.get`: tells a vanished runtime from one the plugin cannot read. */
  readonly get: (account: string, runtimeId: string) => Promise<unknown>
  readonly activeRuns: number
  readonly rule: IdleRule
  readonly now: Date
}

/**
 * Reads a runtime's Jupyter view for the rule. Then:
 * - the fence says the runtime is no longer the plugin's own, or `runtimes.get` finds nothing: `gone`, so the ledger
 *   is closed (design §8.3 step 1: gone → `RUNTIME_GONE`);
 * - anything else that stops the read (auth, transport, the other process's lease, a tainted record): `blocked`, and
 *   the runtime is left alone and listed with the code. A read the plugin cannot complete never releases anything.
 */
export async function readIdle(input: ReadIdleInput): Promise<IdleVerdict> {
  let kernels: readonly KernelInfo[]
  let sessions: readonly SessionInfo[]
  try {
    kernels = await input.kernels(input.record.account, input.record.id)
    sessions = await input.sessions(input.record.account, input.record.id)
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    const code = ColabError.is(error) ? error.code : undefined
    if (code === "RUNTIME_HAS_CREDENTIALS" || code === "RUNTIME_SHARED" || code === "RUNTIME_UNVERIFIED") return { state: "blocked", why: "tainted", code }
    if (code === "RUNTIME_GONE") return { state: "gone", message: "The ledger records it as released." }
    // `RUNTIME_NOT_OURS` is gone only when Colab agrees: B's fence refuses a `creating` record too, and a runtime that
    // still exists in Colab bills whether or not the plugin can read it (review M1).
    try {
      const runtime = await input.get(input.record.account, input.record.id)
      if (runtime === undefined) return { state: "gone", message: "The runtime no longer exists in Colab." }
    } catch (inner) {
      if (inner instanceof Error && inner.name === "AbortError") throw inner
    }
    return { state: "blocked", why: "unreadable", ...(code !== undefined ? { code } : {}) }
  }
  return idleVerdict({ record: input.record, kernels, sessions, activeRuns: input.activeRuns, rule: input.rule, now: input.now })
}
