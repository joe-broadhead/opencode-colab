/**
 * `/colab-cleanup` (design §8.5, boxd §C.5): the person's own cleanup. It lists what costs money, then confirms each
 * action with a permission prompt that only a person answers — `ctx.permission.assert` **without a `source`**, so the
 * prompt is not a tool call and the model never sees it in its context.
 *
 * Which action it asserts, so there is exactly one prompt per action at each access level:
 *
 * - `access: "all"`: the tool actions run unasked, so it asserts the command's own action `colab.cleanup`, which the
 *   default rules ask at this level (and deny at read-only);
 * - `access: "ask-changes"`: it asserts `colab.delete`, the tool action the default rules already ask for, so the
 *   person is never asked twice;
 * - `access: "read-only"`: the command only reports. It asserts nothing and changes nothing (review LOW 3).
 *
 * A yes runs that one release in the plugin's process through the one release function; a no or a deny ends that action,
 * changes nothing, and moves on to the next one. Enterprise runtimes are not stopped here — a stop loses kernel state
 * and there is no idle signal, so the report names `colab_runtimes` and the `runtime.stop` plan with the design's
 * warning. The report holds counts, ids and our own words only.
 */
import type { Plugin } from "@opencode/plugin"
import type { Access } from "../constants.js"
import type { ResolvedAccount } from "../options.js"
import { runtimeResource } from "../domain/actions.js"
import type { Clock, Ledger, Release, RuntimeRecord } from "../ports.js"
import { RELEASE_LOSS } from "./release.js"
import { consumerUsage, dayStart, hours } from "./usage.js"

export const CLEANUP_COMMAND = "colab-cleanup"

export interface CleanupDeps {
  readonly options: { readonly access: Access; readonly accounts: readonly ResolvedAccount[]; readonly autoReleaseMinutes: number; readonly maxRuntimeHours: number }
  readonly ledger: Ledger
  readonly release: Pick<Release, "release">
  readonly clock: Clock
}

export interface CleanupAction {
  readonly record: RuntimeRecord
  readonly account: ResolvedAccount
  /** Why it is worth doing, in our own words: the idle figure and today's runtime-hours. */
  readonly saving: string
  /** Minutes since the ledger last saw a run on it, or since it was created; the report shows it. */
  readonly quietMinutes: number
}

/** The instrumentation a test drives: every assert and every release the command made. */
export interface CleanupTrace {
  readonly asserted: { readonly action: string; readonly resources: readonly string[]; readonly source?: unknown }[]
  readonly released: string[]
  readonly declined: string[]
  readonly failed: { readonly runtime: string; readonly code: string }[]
}

export interface CleanupRun {
  readonly report: string
  readonly outcome: string
  readonly trace: CleanupTrace
}

/** Runtimes a person may release: live, ready, of ours, with no run of ours active. */
export async function cleanupActions(deps: CleanupDeps, now: Date): Promise<readonly CleanupAction[]> {
  const from = dayStart(now)
  const [records, runs] = await Promise.all([deps.ledger.listRuntimes({ live: true }), deps.ledger.listRuns({ state: "running" })])
  const active = new Set(runs.filter((run) => run.runtime !== undefined).map((run) => run.runtime as string))
  const lastSeen = new Map<string, number>()
  for (const run of runs) {
    if (run.runtime === undefined) continue
    const at = Date.parse(run.endedAt ?? run.startedAt)
    if (Number.isFinite(at)) lastSeen.set(run.runtime, Math.max(lastSeen.get(run.runtime) ?? 0, at))
  }
  return records
    .filter((record) => record.state === "ready" && !record.tainted && !active.has(record.id))
    .flatMap((record) => {
      const account = deps.options.accounts.find((entry) => entry.alias === record.account)
      if (!account) return []
      const today = consumerUsage([record], now, from).runtimeHours
      const since = Math.max(lastSeen.get(record.id) ?? 0, Date.parse(record.createdAt) || 0)
      const quietMinutes = Number.isFinite(since) && since > 0 ? Math.max(0, Math.round((now.getTime() - since) / 60_000)) : 0
      return [{ record, account, quietMinutes, saving: `${record.spec.accelerator === "NONE" ? "CPU" : record.spec.accelerator} runtime, ${hours(today)} today` }]
    })
}

const specLabel = (record: RuntimeRecord): string => (record.spec.accelerator === "NONE" ? "CPU" : `${record.spec.accelerator} ${record.spec.variant === "VARIANT_TPU" ? "TPU" : "GPU"}`)

/** The report, before anything is asked: what costs money, and the one sentence a release needs. */
export function cleanupReport(deps: CleanupDeps, actions: readonly CleanupAction[], now: Date): string {
  const lines: string[] = [`Colab cleanup (${deps.options.access})`]
  if (actions.length === 0) {
    lines.push("Runtimes of the plugin's own that cost money now: none.")
  } else {
    lines.push(`Runtimes of the plugin's own that cost money now: ${actions.length}`)
    for (const action of actions) {
      const today = consumerUsage([action.record], now, dayStart(now)).runtimeHours
      lines.push(`- ${action.record.id}: ${specLabel(action.record)} · ${hours(today)} today · no run active for ${action.quietMinutes} min`)
      lines.push(`  ${RELEASE_LOSS}`)
    }
  }
  lines.push("Enterprise runtimes are not touched here: colab_runtimes lists them with their $/h, and stopping one is a runtime.stop plan, which says what a stop loses.")
  if (deps.options.access === "read-only") lines.push("Read only: this is a report; nothing was released and nothing was asked.")
  else lines.push("Each release below asks you first; a no ends that one and changes nothing.")
  return lines.join("\n")
}

/**
 * Runs the command once. `assert` is `ctx.permission.assert`, called without a `source`; `synthetic` posts the report
 * and the outcome with `resume: false`.
 */
export async function runCleanup(input: {
  readonly deps: CleanupDeps
  readonly sessionID: string
  readonly delivery?: unknown
  readonly assert: (request: { readonly sessionID: string; readonly action: string; readonly resources: readonly string[]; readonly metadata: Readonly<Record<string, unknown>> }) => Promise<void>
  readonly synthetic: (text: string, description: string) => Promise<unknown>
}): Promise<CleanupRun> {
  const now = input.deps.clock.now()
  const trace: CleanupTrace = { asserted: [], released: [], declined: [], failed: [] }
  const actions = await cleanupActions(input.deps, now)
  const report = cleanupReport(input.deps, actions, now)
  await input.synthetic(report, "Colab cleanup")

  const access = input.deps.options.access
  if (access === "read-only") {
    return { report, outcome: "Read only: nothing was released.", trace }
  }

  const outcomes: string[] = []
  for (const action of actions) {
    // At `all` the tool action is allowed, so the command's own action is the prompt; at `ask-changes` the tool
    // action already asks, and asserting it here is that one prompt (design §8.5).
    const actionName = access === "ask-changes" ? "colab.delete" : "colab.cleanup"
    const resources = [runtimeResource(action.account.alias, action.record.id)]
    trace.asserted.push({ action: actionName, resources })
    try {
      await input.assert({
        sessionID: input.sessionID,
        action: actionName,
        resources,
        metadata: { account: action.account.alias, runtime: action.record.id, keep: [...action.record.keep], lost: RELEASE_LOSS, saving: action.saving },
      })
    } catch {
      trace.declined.push(action.record.id)
      outcomes.push(`${action.record.id}: declined, nothing changed.`)
      continue
    }
    try {
      const answer = await input.deps.release.release(action.record, { reason: "plan", force: false }, new AbortController().signal)
      if (answer.released) {
        trace.released.push(action.record.id)
        outcomes.push(`${action.record.id}: released, ${answer.harvested.length} file${answer.harvested.length === 1 ? "" : "s"} harvested into ${input.deps.options.access === "read-only" ? "the harvest folder" : ".colab/harvest"}${answer.warnings.includes("UNHARVESTED") ? " (keep paths could not be harvested)" : ""}.`)
      } else {
        outcomes.push(`${action.record.id}: not released, nothing changed.`)
      }
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE"
      trace.failed.push({ runtime: action.record.id, code })
      outcomes.push(`${action.record.id}: not released (${code}).`)
    }
  }
  const outcome = outcomes.length === 0 ? "Nothing to release." : outcomes.join(" ")
  await input.synthetic(`Colab cleanup: ${outcome}`, "Colab cleanup result")
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
      description: "List what Colab costs now and release an idle runtime of the plugin's own, asking once per runtime",
      execute: async ({ sessionID, delivery }) => {
        await runCleanup({
          deps,
          sessionID,
          delivery,
          // No `source`: a person-only prompt, never a tool call the model could replay (design §8.5, boxd §C.5).
          assert: (request) => ctx.permission.assert(request as never),
          synthetic: (text, description) => ctx.session.synthetic({ sessionID, delivery, text, description, resume: false } as never),
        }).catch(() => undefined)
      },
    })
  })
}
