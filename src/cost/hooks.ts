/**
 * Layer 3's hooks (design §8.4, boxd §C.4): what agents see and use. A ≤ 200-character line on the **tail** of
 * `messages` when a runtime of ours runs and the coarse fingerprint changed (`system` is never touched, so the provider
 * cache keeps the history); a compaction part asking the summary to keep the open runtime ids; and an
 * `experimental.idle` note only when money is burning, automation will not handle it, at most twice an hour, never in
 * the execution its own note started. No hook makes a Google call (the ledger is read through a ten-second cache), and
 * no text here is notebook text, a token or the runtime URL.
 */
import type { Plugin } from "@opencode/plugin"
import type { Access } from "../constants.js"
import type { Clock, Ledger } from "../ports.js"
import { automationState, type AutomationState } from "./automation.js"
import { hours } from "./usage.js"

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

const label = (record: { readonly spec: { readonly accelerator: string; readonly variant: string } }): string =>
  record.spec.accelerator === "NONE" ? "CPU" : `${record.spec.accelerator} ${record.spec.variant === "VARIANT_TPU" ? "TPU" : "GPU"}`

/** The ledger read every hook uses: a small local read, never a provider call. */
export function snapshotReader(deps: HookDeps): () => Promise<HookSnapshot> {
  return async () => {
    const now = deps.clock.now()
    const [records, runs] = await Promise.all([deps.ledger.listRuntimes({ live: true }), deps.ledger.listRuns({})])
    const start = new Date(now.getTime()).setHours(0, 0, 0, 0)
    const runtimeHoursToday = records.reduce((sum, record) => {
      const from = Math.max(Date.parse(record.createdAt), start)
      const to = record.releasedAt ? Math.min(Date.parse(record.releasedAt), now.getTime()) : now.getTime()
      return sum + (Number.isFinite(from) && to > from ? (to - from) / 3_600_000 : 0)
    }, 0)
    const snapshot: HookSnapshot = {
      runtimes: records
        .filter((record) => record.state === "ready" || record.state === "creating")
        .map((record) => ({ id: record.id, spec: label(record), runningMinutes: Math.max(0, Math.round((now.getTime() - Date.parse(record.createdAt)) / 60_000)) }))
        .filter((entry) => Number.isFinite(entry.runningMinutes))
        .sort((a, b) => b.runningMinutes - a.runningMinutes),
      activeRuns: runs.filter((run) => run.state === "running").length,
      runtimeHoursToday: Math.round(runtimeHoursToday * 10) / 10,
    }
    return snapshot
  }
}

/** The fingerprint a line is added on: coarse figures only, so a quiet fleet adds nothing. */
export const snapshotFingerprint = (snapshot: HookSnapshot): string =>
  [snapshot.runtimes.map((runtime) => runtime.id).join(","), snapshot.activeRuns, Math.round(snapshot.runtimeHoursToday * 10)].join("|")

/** The one line, at most 200 characters, plugin fields only (design §8.4); the call only when it fits whole. */
export function contextLine(snapshot: HookSnapshot, automation: AutomationState, topCall?: string): string | undefined {
  if (snapshot.runtimes.length === 0) return undefined
  const first = snapshot.runtimes[0]!
  const line = `colab: ${snapshot.runtimes.length} runtime${snapshot.runtimes.length === 1 ? "" : "s"} ours (${first.spec}, ${hours(snapshot.runtimeHoursToday)} today); release ${automation === "on" || automation === "on (consent)" ? "on" : "off"}.`
  return topCall !== undefined && `${line} Cleanup: ${topCall}`.length <= 200 ? `${line} Cleanup: ${topCall}` : line.slice(0, 200)
}

/** The compaction part: ids only, and the one tool that lists them again. */
export function compactionLine(ids: readonly string[]): string | undefined {
  if (ids.length === 0) return undefined
  const shown = ids.slice(0, 10)
  return `Keep in the summary: colab runtimes open: ${shown.join(", ")}${ids.length > 10 ? `, and ${ids.length - 10} more` : ""}; colab_runtimes lists all.`
}

/** Appends a text part to the tail of `messages`, leaving `system` and every earlier message byte-identical. */
export function appendToTail(messages: MessageLike[], text: string): void {
  const last = messages.at(-1) as MessageLike | undefined
  if (last !== undefined && last.role === "user" && Array.isArray(last.content)) last.content.push({ type: "text", text })
  else messages.push({ role: "user", content: [{ type: "text", text }] })
}

export interface IdleNoteState {
  readonly fingerprint: string
  readonly at: number
}

/** Whether the idle check speaks: money burning, automation off, a change, and at most twice an hour. */
export function shouldNoteIdle(input: {
  readonly snapshot: HookSnapshot
  readonly automation: AutomationState
  readonly idleMinutes: number
  readonly now: number
  readonly last?: IdleNoteState
  readonly background: number
}): boolean {
  const first = input.snapshot.runtimes[0]
  if (input.background > 0 || input.snapshot.activeRuns > 0 || first === undefined) return false
  if (input.automation === "on" || input.automation === "on (consent)" || input.automation === "not-owner") return false
  if (first.runningMinutes < input.idleMinutes) return false
  return input.last === undefined || (input.last.fingerprint !== snapshotFingerprint(input.snapshot) && input.now - input.last.at >= 30 * 60_000)
}

/** The idle note's text: counts, hours and one call, in our own words. */
export const idleNote = (snapshot: HookSnapshot, automation: AutomationState): string =>
  `colab: ${snapshot.runtimes.length} runtime${snapshot.runtimes.length === 1 ? " is" : "s are"} running with no run active (${hours(snapshot.runtimeHoursToday)} today) and release is ${automation === "off (access)" ? "off at this access level" : "off"}. Run /colab-cleanup, or colab_plan({ action: "runtime.delete", params: { runtime: "${snapshot.runtimes[0]?.id}" } }).`

export interface HookRegistration {
  readonly stop: readonly { dispose(): Promise<void> }[]
  /** Hook names that could not be registered: status can say the idle check is off on such a host (design §8.4). */
  readonly problems: readonly string[]
}

type HookContext = { readonly session: Pick<Plugin.Context["session"], "hook" | "synthetic" | "context"> }

/** Registers the three hooks, each on its own, so one host's missing experimental hook leaves the other two. */
export async function registerHooks(ctx: HookContext, deps: HookDeps): Promise<HookRegistration> {
  const stop: { dispose(): Promise<void> }[] = []
  const problems: string[] = []
  const read = snapshotReader(deps)
  // Per-session memory, capped so a long-lived process with many sessions cannot grow it without bound.
  const fingerprints = new Map<string, string>()
  const notes = new Map<string, IdleNoteState>()
  const remember = <T>(map: Map<string, T>, key: string, value: T) => {
    map.set(key, value)
    if (map.size > 1_000) map.clear()
  }
  const state = (): AutomationState => automationState({ automation: deps.options.automation, access: deps.options.access, owner: true })

  const register = async (name: "context" | "compaction" | "experimental.idle", callback: (input: never) => Promise<void>): Promise<void> => {
    try {
      stop.push(await ctx.session.hook(name, callback as never))
    } catch {
      problems.push(name === "experimental.idle" ? "idle" : name)
    }
  }

  await register("context", async (input) => {
    try {
      const snapshot = await read()
      const top = snapshot.runtimes[0]
      const line = contextLine(snapshot, state(), top === undefined ? undefined : `colab_plan({ action: "runtime.delete", params: { runtime: "${top.id}" } })`)
      if (line === undefined) return
      const fingerprint = snapshotFingerprint(snapshot)
      const sessionID = (input as { sessionID: string }).sessionID
      if (fingerprints.get(sessionID) === fingerprint) return
      appendToTail((input as { messages: MessageLike[] }).messages, line)
      remember(fingerprints, sessionID, fingerprint)
    } catch {
      // A hook never fails a request and never throws (AGENTS.md).
    }
  })

  await register("compaction", async (input) => {
    try {
      const line = compactionLine((await read()).runtimes.map((runtime) => runtime.id))
      if (line !== undefined) appendToTail((input as { messages: MessageLike[] }).messages, line)
      // The context line speaks again after a compaction.
      fingerprints.delete((input as { sessionID: string }).sessionID)
    } catch {
      // As above.
    }
  })

  await register("experimental.idle", async (input) => {
    try {
      const now = deps.clock.now().getTime()
      const snapshot = await read()
      const automation = state()
      const { sessionID, background } = input as { sessionID: string; background: readonly unknown[] }
      const last = notes.get(sessionID)
      if (!shouldNoteIdle({ snapshot, automation, idleMinutes: deps.options.autoReleaseMinutes, now, ...(last !== undefined ? { last } : {}), background: background.length })) return
      // Never in the execution the plugin's own note started: the session's newest input must not be that note. Both
      // ends of `context` are read so the guard does not depend on the list's order.
      const messages = await ctx.session.context({ sessionID } as never)
      const own = (entry: unknown) => {
        const item = entry as { type?: unknown; metadata?: { colab?: unknown } } | undefined
        return item?.type === "synthetic" && item.metadata?.colab === "idle-check"
      }
      if (own(messages[0]) || own(messages.at(-1))) return
      // Marked before the post, so a re-entry in this same execution is silent even if it beats the queue.
      remember(notes, sessionID, { at: now, fingerprint: snapshotFingerprint(snapshot) })
      await ctx.session.synthetic({ sessionID, text: idleNote(snapshot, automation), description: "Colab cost check", metadata: { colab: "idle-check", id: `${sessionID}:${now}` }, resume: false } as never)
    } catch {
      // An experimental hook that fails is off; layers 1 and 2 still hold (design §8.4, C.6).
    }
  })

  return { stop, problems }
}
