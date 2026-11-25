/**
 * The `attention` list design §8.3 names, from the ledger alone: runtimes of ours the automation leaves alone, in the
 * plugin's own words (no Google text, token or URL). `colab_status`, `/colab` and the automation share it, so the
 * three cannot drift; a read that fails is added by its caller, which is the one thing the ledger cannot see.
 */
import type { Options } from "../../options.js"
import type { RunRecord, RuntimeRecord } from "../ports.js"

/** A create's LRO is waited inside the host call budget; older than this, the create never finished (design §9.5). */
export const CREATE_STALE_MINUTES = 15

export const staleCreate = (record: Pick<RuntimeRecord, "state" | "createdAt">, now: Date): boolean =>
  record.state === "creating" && now.getTime() - Date.parse(record.createdAt) > CREATE_STALE_MINUTES * 60_000

/** An account with `access: "read"` changes nothing (design §4): the automation never releases its runtimes. */
export const readAccount = (options: Pick<Options, "accounts">, alias: string): boolean => options.accounts.find((account) => account.alias === alias)?.access === "read"

/** At most one line per runtime, most severe first: a running run, a taint, a stale create, a read account. */
export function costAttention(input: { readonly runtimes: readonly RuntimeRecord[]; readonly runs: readonly RunRecord[]; readonly options: Pick<Options, "accounts">; readonly now: Date }): string[] {
  const lines: string[] = []
  const running = input.runs.filter((run) => run.state === "running")
  for (const record of input.runtimes) {
    if (record.state !== "ready" && record.state !== "creating") continue
    const run = running.find((entry) => entry.runtime === record.id)
    if (run !== undefined) lines.push(`Runtime ${record.id}: a run has been running since ${run.startedAt}; colab_cancel or plan with force.`)
    else if (record.tainted) lines.push(`Runtime ${record.id}: tainted; only a plan releases it, keep files lost.`)
    else if (staleCreate(record, input.now)) lines.push(`Runtime ${record.id}: its create never finished; release it by plan.`)
    else if (readAccount(input.options, record.account)) lines.push(`Runtime ${record.id}: its account is read; automation leaves it, /colab-cleanup may release it.`)
  }
  return lines
}
