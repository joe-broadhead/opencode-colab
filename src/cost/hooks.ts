/**
 * Layer 3's hooks (design §8.4, boxd §C.4, verified on the 2.2.3 and 2.3.0 shapes): what agents see and use.
 *
 * 1. `session.hook("context")` — a ≤ 200-character line on the **tail** of `messages` only when a runtime of ours is
 *    running and the coarse fingerprint changed. `system` is never touched: providers cache the prefix in the order
 *    tools → system → messages, so a changed system part would uncache the whole history on every turn. When the newest
 *    message is ours (`user`), one text part is appended to it; otherwise one `user` message holding only the line is
 *    appended after it. The change applies to this request only, so the history the next request caches is unchanged.
 *    A request where nothing changed adds nothing: no tokens.
 * 2. `session.hook("compaction")` — one text part asking the summary to keep the open runtime ids: a hook can ask, not
 *    force.
 * 3. `session.hook("experimental.idle")` — an end-of-turn note only when money is burning, automation will not handle
 *    it, the fingerprint changed, at most once per 30 minutes per session, and never in the execution its own note
 *    started (the newest session input is not the plugin's own note).
 *
 * Nothing in a hook makes a Google call: the snapshot comes from the ledger, cached for ten seconds. All texts are the
 * plugin's own words, counts and ids — never notebook text, a token or the runtime URL.
 */
import type { Plugin } from "@opencode/plugin"
import type { Access } from "../constants.js"
import type { Clock, Ledger, RunRecord, RuntimeRecord } from "../ports.js"
import { automationState, type AutomationState } from "./automation.js"
import { hours } from "./usage.js"

/** A message part as the host's `SessionContext.messages` takes it: `{ type: "text", text }`. */
type TextPart = { readonly type: "text"; readonly text: string }
type MessageLike = { readonly role: string; content: TextPart[] }

export interface HookSnapshot {
  /** Live consumer runtimes of ours, oldest first. */
  readonly runtimes: readonly { readonly id: string; readonly spec: string; readonly runningMinutes: number }[]
  readonly activeRuns: number
  readonly runtimeHoursToday: number
}

export interface HookDeps {
  readonly options: { readonly access: Access; readonly automation: "auto" | "on" | "off"; readonly autoReleaseMinutes: number }
  readonly ledger: Pick<Ledger, "listRuntimes" | "listRuns">
  readonly clock: Clock
}

const specLabel = (record: RuntimeRecord): string => (record.spec.accelerator === "NONE" ? "CPU" : `${record.spec.accelerator} ${record.spec.variant === "VARIANT_TPU" ? "TPU" : "GPU"}`)

/** The ledger read every hook uses, cached for ten seconds: a request costs one small folder read at most. */
export function snapshotReader(deps: HookDeps, cacheMs = 10_000): () => Promise<HookSnapshot> {
  let cache: { readonly at: number; readonly snapshot: HookSnapshot } | undefined
  return async () => {
    const now = deps.clock.now()
    if (cache !== undefined && now.getTime() - cache.at < cacheMs) return cache.snapshot
    const [records, runs] = await Promise.all([deps.ledger.listRuntimes({ live: true }), deps.ledger.listRuns({})])
    const active = runs.filter((run: RunRecord) => run.state === "running")
    const runtimeHoursToday = records.reduce((sum, record) => {
      const start = Math.max(Date.parse(record.createdAt), new Date(now.getTime()).setHours(0, 0, 0, 0))
      const end = record.releasedAt ? Math.min(Date.parse(record.releasedAt), now.getTime()) : now.getTime()
      return sum + (Number.isFinite(start) && end > start ? (end - start) / 3_600_000 : 0)
    }, 0)
    const snapshot: HookSnapshot = {
      runtimes: records
        .filter((record) => record.state === "ready" || record.state === "creating")
        .map((record) => ({ id: record.id, spec: specLabel(record), runningMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(record.createdAt)) / 60_000)) }))
        .filter((entry) => Number.isFinite(entry.runningMinutes))
        .sort((a, b) => b.runningMinutes - a.runningMinutes),
      activeRuns: active.length,
      runtimeHoursToday: Math.round(runtimeHoursToday * 10) / 10,
    }
    cache = { at: now.getTime(), snapshot }
    return snapshot
  }
}

/** The fingerprint a line is added on: coarse figures only, so a quiet fleet adds nothing. */
export const snapshotFingerprint = (snapshot: HookSnapshot): string =>
  [snapshot.runtimes.map((runtime) => runtime.id).join(","), snapshot.activeRuns, Math.round(snapshot.runtimeHoursToday * 10)].join("|")

/** The one line, at most 200 characters, plugin fields only (design §8.4). */
export function contextLine(snapshot: HookSnapshot, automation: AutomationState, topCall?: string): string | undefined {
  if (snapshot.runtimes.length === 0) return undefined
  const first = snapshot.runtimes[0]!
  const running = `${snapshot.runtimes.length} runtime${snapshot.runtimes.length === 1 ? "" : "s"} of the plugin's own (${first.spec}, ${hours(snapshot.runtimeHoursToday)} today)`
  const state = automation === "on" || automation === "on (consent)" ? "automatic release on" : "automatic release off"
  const line = `colab: ${running}; ${state}.`
  if (topCall !== undefined && `${line} Cleanup: ${topCall}`.length <= 200) return `${line} Cleanup: ${topCall}`
  // Never cut a call in half: the figures alone are the line when the call does not fit.
  return line.length <= 200 ? line : `${line.slice(0, 197)}…`
}

/** The compaction part: ids only, and the one tool that lists them again. */
export function compactionLine(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined
  const shown = ids.slice(0, 10)
  const more = ids.length > shown.length ? `, and ${ids.length - shown.length} more` : ""
  return `Keep this list in the summary: colab runtimes open: ${shown.join(", ")}${more}; colab_runtimes lists all.`
}

/** Appends a text part to the tail of `messages`, leaving `system` and every earlier message byte-identical. */
export function appendToTail(messages: MessageLike[], text: string): void {
  const last = messages.at(-1) as MessageLike | undefined
  if (last !== undefined && last.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text })
    return
  }
  // A new message object, the host's own shape: `{ role, content: [{ type: "text", text }] }`.
  messages.push({ role: "user", content: [{ type: "text", text }] })
}

export interface IdleNoteState {
  readonly fingerprint: string
  readonly at: number
}

/** Whether the idle check speaks: money burning, automation off, a change, and no more than twice an hour. */
export function shouldNoteIdle(input: {
  readonly snapshot: HookSnapshot
  readonly automation: AutomationState
  readonly idleMinutes: number
  readonly now: number
  readonly last?: IdleNoteState
  readonly background: number
}): boolean {
  if (input.background > 0) return false
  if (input.automation === "on" || input.automation === "on (consent)" || input.automation === "not-owner") return false
  if (input.snapshot.runtimes.length === 0) return false
  if (input.snapshot.activeRuns > 0) return false
  if (input.snapshot.runtimes[0]!.runningMinutes < input.idleMinutes) return false
  const fingerprint = snapshotFingerprint(input.snapshot)
  if (input.last !== undefined) {
    if (input.last.fingerprint === fingerprint) return false
    if (input.now - input.last.at < 30 * 60_000) return false
  }
  return true
}

/** The idle note's text: counts, hours and one call, in our own words. */
export function idleNote(snapshot: HookSnapshot, automation: AutomationState): string {
  const ids = snapshot.runtimes.map((runtime) => runtime.id)
  return `colab: ${ids.length} runtime${ids.length === 1 ? "" : "s"} of the plugin's own ${ids.length === 1 ? "is" : "are"} running with no run active (${hours(snapshot.runtimeHoursToday)} today) and automatic release is ${automation === "off (access)" ? "off at this access level" : "off"}. Run /colab-cleanup, or release one with colab_plan({ action: "runtime.delete", params: { runtime: "${ids[0]}" } }).`
}

export interface HookRegistration {
  readonly stop: readonly { dispose(): Promise<void> }[]
  /** Hook names that could not be registered, with the plugin's code: status says so (design §8.4). */
  readonly problems: readonly string[]
}

type HookContext = {
  readonly session: Pick<Plugin.Context["session"], "hook" | "synthetic" | "context">
}

/** Registers the three hooks, each on its own, so one host's missing experimental hook leaves the other two. */
export async function registerHooks(ctx: HookContext, deps: HookDeps): Promise<HookRegistration> {
  const stop: { dispose(): Promise<void> }[] = []
  const problems: string[] = []
  const read = snapshotReader(deps)
  const fingerprints = new Map<string, string>()
  const notes = new Map<string, IdleNoteState>()

  const automationFor = (): AutomationState => automationState({ automation: deps.options.automation, access: deps.options.access, owner: true })

  try {
    stop.push(
      await ctx.session.hook("context", async (input) => {
        try {
          const snapshot = await read()
          const automation = automationFor()
          const top = snapshot.runtimes[0]
          const line = contextLine(snapshot, automation, top === undefined ? undefined : `colab_plan({ action: "runtime.delete", params: { runtime: "${top.id}" } })`)
          if (line === undefined) return
          const fingerprint = snapshotFingerprint(snapshot)
          if (fingerprints.get(input.sessionID as string) === fingerprint) return
          appendToTail(input.messages as unknown as { role: string; content: TextPart[] }[], line)
          fingerprints.set(input.sessionID as string, fingerprint)
        } catch {
          // A hook never fails a request and never throws (AGENTS.md).
        }
      }),
    )
  } catch {
    problems.push("context")
  }

  try {
    stop.push(
      await ctx.session.hook("compaction", async (input) => {
        try {
          const snapshot = await read()
          const line = compactionLine(snapshot.runtimes.map((runtime) => runtime.id))
          if (line !== undefined) appendToTail(input.messages as unknown as { role: string; content: TextPart[] }[], line)
          // The context line speaks again after a compaction.
          fingerprints.delete(input.sessionID as string)
        } catch {
          // As above.
        }
      }),
    )
  } catch {
    problems.push("compaction")
  }

  try {
    stop.push(
      await ctx.session.hook("experimental.idle", async (input) => {
        try {
          const now = deps.clock.now().getTime()
          const snapshot = await read()
          const automation = automationFor()
          const sessionID = input.sessionID as string
          if (
            !shouldNoteIdle({
              snapshot,
              automation,
              idleMinutes: deps.options.autoReleaseMinutes,
              now,
              ...(notes.get(sessionID) !== undefined ? { last: notes.get(sessionID)! } : {}),
              background: input.background.length,
            })
          ) {
            return
          }
          // Never in the execution the plugin's own note started: the newest input must not be that note.
          const messages = await ctx.session.context({ sessionID } as never)
          const newest = messages.at(-1) as { metadata?: { colab?: unknown } } | undefined
          if (newest?.metadata?.colab === "idle-check") return
          await ctx.session.synthetic({
            sessionID,
            text: idleNote(snapshot, automation),
            description: "Colab cost check",
            metadata: { colab: "idle-check", id: `${sessionID}:${now}` },
            resume: false,
          } as never)
          notes.set(sessionID, { at: now, fingerprint: snapshotFingerprint(snapshot) })
        } catch {
          // An experimental hook that fails is off, and status still reports automation: design §8.4, C.6.
        }
      }),
    )
  } catch {
    problems.push("idle")
  }

  return { stop, problems }
}
