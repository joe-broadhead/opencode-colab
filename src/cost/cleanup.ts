/**
 * `/colab-cleanup` (design §8.5, boxd §C.5): the person's own cleanup. It lists every live runtime of ours — whatever it
 * has run, tainted, or still creating — then confirms each release with a permission prompt only a person answers:
 * `ctx.permission.assert` **without a `source`**, so it is not a tool call the model could replay.
 *
 * One prompt per action at each access level: at `all` the command's own `colab.cleanup` (the default rules ask it), at
 * `ask-changes` the tool's `colab.delete` (already asked), and at `read-only` nothing is asserted or released — a report
 * only. A yes runs that one release through the one release function; a no changes nothing and moves on. A runtime with
 * a run recorded running is listed but not offered (the release would refuse it); the person cancels first. Enterprise
 * runtimes are not stopped here: `colab_runtimes` lists them, and a `runtime.stop` plan says what a stop loses.
 */
import type { Plugin } from "@opencode/plugin"
import type { Access } from "../constants.js"
import type { ResolvedAccount } from "../options.js"
import { runtimeResource } from "../domain/actions.js"
import type { Clock, Ledger, Release, RuntimeRecord } from "../ports.js"
import { RELEASE_LOSS } from "./release.js"
import { consumerUsage, dayStart, hours, specLabel } from "./usage.js"

export const CLEANUP_COMMAND = "colab-cleanup"

export interface CleanupDeps {
  readonly options: { readonly access: Access; readonly accounts: readonly ResolvedAccount[]; readonly autoReleaseMinutes: number; readonly maxRuntimeHours: number; readonly workDir: string }
  readonly ledger: Ledger
  readonly release: Pick<Release, "release">
  readonly clock: Clock
}

export interface CleanupAction {
  readonly record: RuntimeRecord
  readonly account: ResolvedAccount
  /** Minutes since the ledger last saw a run on it, or since it was created. */
  readonly quietMinutes: number
  /** A run of ours is recorded running; the release would refuse it, so the report says to cancel first. */
  readonly blocked: boolean
}

/** What a test drives: every release, decline, block and failure the command met. */
export interface CleanupTrace {
  readonly released: string[]
  readonly declined: string[]
  readonly blocked: string[]
  readonly failed: { readonly runtime: string; readonly code: string }[]
}

export interface CleanupRun {
  readonly report: string
  /** One line on what the prompts led to, posted after them. */
  readonly outcome: string
  readonly trace: CleanupTrace
}

/** Every live runtime of ours, ready or creating: one that has run code still costs money. */
export async function cleanupActions(deps: CleanupDeps, now: Date): Promise<readonly CleanupAction[]> {
  const [records, runs] = await Promise.all([deps.ledger.listRuntimes({ live: true }), deps.ledger.listRuns({})])
  const running = new Set(runs.filter((run) => run.state === "running" && run.runtime !== undefined).map((run) => run.runtime as string))
  const lastSeen = new Map<string, number>()
  for (const run of runs) {
    if (run.runtime === undefined) continue
    const at = Date.parse(run.endedAt ?? run.startedAt)
    if (Number.isFinite(at)) lastSeen.set(run.runtime, Math.max(lastSeen.get(run.runtime) ?? 0, at))
  }
  return records.flatMap((record) => {
    if (record.state !== "ready" && record.state !== "creating") return []
    const account = deps.options.accounts.find((entry) => entry.alias === record.account)
    if (!account) return []
    const since = Math.max(lastSeen.get(record.id) ?? 0, Date.parse(record.createdAt) || 0)
    return [
      {
        record,
        account,
        quietMinutes: Number.isFinite(since) && since > 0 ? Math.max(0, Math.round((now.getTime() - since) / 60_000)) : 0,
        blocked: running.has(record.id),
      },
    ]
  })
}

const note = (action: CleanupAction): string =>
  action.blocked
    ? "a run is recorded running; colab_cancel first"
    : action.record.state === "creating"
      ? "create never finished; keep files lost"
      : action.record.tainted
        ? "tainted; keep files lost"
        : `no run for ${action.quietMinutes} min`

/** The report, before anything is asked: what costs money, and the one sentence a release needs. */
export function cleanupReport(deps: CleanupDeps, actions: readonly CleanupAction[], now: Date): string {
  const lines: string[] = [`Colab cleanup (${deps.options.access})`, `Runtimes of the plugin's own that cost money now: ${actions.length}`]
  if (actions.length > 0) lines.push(RELEASE_LOSS)
  for (const action of actions) lines.push(`- ${action.record.id}: ${action.record.state === "creating" ? "creating" : specLabel(action.record.spec)} · ${hours(consumerUsage([action.record], now, dayStart(now)).runtimeHours)} today · ${note(action)}`)
  lines.push("Enterprise runtimes: see colab_runtimes and a runtime.stop plan.")
  lines.push(deps.options.access === "read-only" ? "Read only: a report; nothing released, nothing asked." : "Each release asks first; a no changes nothing.")
  return lines.join("\n")
}

/** Runs the command once. `assert` is `ctx.permission.assert`, called without a `source`. */
export async function runCleanup(input: {
  readonly deps: CleanupDeps
  readonly sessionID: string
  readonly delivery?: unknown
  readonly assert: (request: { readonly sessionID: string; readonly action: string; readonly resources: readonly string[]; readonly metadata: Readonly<Record<string, unknown>> }) => Promise<void>
  readonly synthetic: (text: string, description: string) => Promise<unknown>
}): Promise<CleanupRun> {
  const now = input.deps.clock.now()
  const trace: CleanupTrace = { released: [], declined: [], blocked: [], failed: [] }
  const actions = await cleanupActions(input.deps, now)
  const report = cleanupReport(input.deps, actions, now)
  await input.synthetic(report, "Colab cleanup")

  const access = input.deps.options.access
  if (access === "read-only") return { report, outcome: "Read only: nothing was released.", trace }

  for (const action of actions) {
    if (action.blocked) {
      trace.blocked.push(action.record.id)
      continue
    }
    // At `all` the tool action is allowed, so the command's own action is the prompt; at `ask-changes` the tool
    // action already asks, and asserting it here is that one prompt (design §8.5).
    const actionName = access === "ask-changes" ? "colab.delete" : "colab.cleanup"
    const resources = [runtimeResource(action.account.alias, action.record.id)]
    try {
      await input.assert({
        sessionID: input.sessionID,
        action: actionName,
        resources,
        metadata: { account: action.account.alias, runtime: action.record.id, keep: [...action.record.keep], lost: RELEASE_LOSS, quietMinutes: action.quietMinutes },
      })
    } catch {
      trace.declined.push(action.record.id)
      continue
    }
    try {
      const answer = await input.deps.release.release(action.record, { reason: "plan", force: false }, new AbortController().signal)
      if (answer.released) trace.released.push(action.record.id)
    } catch (error) {
      trace.failed.push({ runtime: action.record.id, code: typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE" })
    }
  }
  const outcome = `Colab cleanup: released ${trace.released.length}, declined ${trace.declined.length}, blocked ${trace.blocked.length}, failed ${trace.failed.length}.`
  await input.synthetic(outcome, "Colab cleanup result")
  return { report, outcome, trace }
}

type CleanupContext = {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
  readonly permission: Pick<Plugin.Context["permission"], "assert">
}

/** Registers `/colab-cleanup`; the caller keeps the registration and disposes it with the plugin. */
export async function registerCleanup(ctx: CleanupContext, deps: CleanupDeps): Promise<{ dispose(): Promise<void> }> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: CLEANUP_COMMAND,
      description: "List what Colab costs now and release a runtime of the plugin's own, asking once per runtime",
      execute: async ({ sessionID, delivery }) => {
        await runCleanup({
          deps,
          sessionID,
          delivery,
          // No `source`: a person-only prompt, never a tool call the model could replay (design §8.5, boxd §C.5).
          assert: (request) => ctx.permission.assert(request as never),
          synthetic: (text, description) => ctx.session.synthetic({ sessionID, delivery, text, description, resume: false } as never),
        }).catch((error: unknown) => {
          // The command has no tool result, so a failure is posted where the person reads the report.
          const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE"
          return ctx.session.synthetic({ sessionID, delivery, text: `Colab cleanup could not run (${code}); nothing changed.`, description: "Colab cleanup", resume: false } as never)
        })
      },
    })
  })
}
