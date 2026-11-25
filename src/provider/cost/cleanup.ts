/**
 * The cleanup read side: every live runtime of ours, whatever it has run, tainted or still creating, with what it costs
 * and whether a run still blocks its release. The `cleanup` method and `/colab-cleanup` release them through the one
 * release function; Enterprise runtimes are listed by `runtimes_read` and stopped by a plan.
 */
import type { Access } from "../../constants.js"
import type { ResolvedAccount } from "../../options.js"
import type { Clock, Ledger, Release, RuntimeRecord } from "../ports.js"
import { RELEASE_LOSS } from "./release.js"
import { consumerUsage, dayStart, hours, specLabel } from "./usage.js"

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


/** The report, before anything is asked: what costs money, and the one sentence a release needs. */
export function cleanupReport(deps: CleanupDeps, actions: readonly CleanupAction[], now: Date): string {
  const lines: string[] = [`Colab cleanup (${deps.options.access})`, `Runtimes of ours that cost money: ${actions.length}`]
  if (actions.length > 0) lines.push(RELEASE_LOSS)
  for (const action of actions) {
    const note = action.blocked ? "a run is recorded running; colab_cancel first" : action.record.state === "creating" ? "create never finished; keep files lost" : action.record.tainted ? "tainted; keep files lost" : `no run for ${action.quietMinutes} min`
    lines.push(`- ${action.record.id}: ${action.record.state === "creating" ? "creating" : specLabel(action.record.spec)} · ${hours(consumerUsage([action.record], now, dayStart(now)).runtimeHours)} today · ${note}`)
  }
  lines.push("Enterprise runtimes: see colab_runtimes and a runtime.stop plan.")
  lines.push(deps.options.access === "read-only" ? "Read only: a report; nothing released." : "Each release is a change: allowed at all, asked under ask-changes, refused under read-only.")
  return lines.join("\n")
}

