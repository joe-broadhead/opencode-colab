/**
 * `colab_cancel` (design §6, §9.4): interrupt a run's kernel, restart it (state lost), or cancel an Enterprise job.
 *
 * A run this process collects is interrupted through the kernel handle the registry holds; a notebook run whose
 * stream did not outlive the process is reached by re-opening its session (`oc-<nonce>-nb-…`) and interrupting that
 * kernel, which is the same kernel and the same variables. A scratch run has no notebook path in the ledger, so a
 * detached one can only be found when exactly one of the runtime's own sessions is left; otherwise the answer says the
 * run is not collected here and the kernel-side watchdog still bounds it.
 *
 * The Enterprise branch is package E's, through `deps.enterprise`; this tool's own `colab.cancel` assert on the job's
 * operation ran in the wrapper, and E asserts `colab.read` before the reads it makes.
 */
import type { InputOf } from "../domain/contract.js"
import { ColabError } from "../domain/errors.js"
import type { RuntimeRecord } from "../ports.js"
import type { HandlerContext, ToolHandler } from "../tools/types.js"
import { liveRun } from "./runs.js"
import { ours, sessionName } from "./support.js"

const terminal = (run: { readonly state: string }) => !["running", "detached"].includes(run.state)

/** The runtime record a detached run's session lives on, without refusing a tainted one (the run already started). */
async function runtimeOf(ctx: HandlerContext, id: string): Promise<RuntimeRecord> {
  const record = await ctx.deps.ledger.getRuntime(id)
  if (!record || record.account !== ctx.account.alias) throw new ColabError("NOT_FOUND", "The run's runtime is not in the plugin's ledger.")
  if (record.state === "released" || record.state === "gone") throw new ColabError("RUNTIME_GONE")
  return ours(record, ctx.account.alias, id).record
}

export const cancel: ToolHandler<"cancel"> = {
  async run(input: InputOf<"cancel">, ctx) {
    if (input.job !== undefined) {
      const answer = await ctx.deps.enterprise.cancel(ctx.account.alias, input.job, ctx.call.signal, ctx.providerRead)
      return answer as never
    }
    const runId = input.runId!
    const run = await ctx.deps.ledger.getRun(runId)
    if (!run || run.account !== ctx.account.alias) throw new ColabError("NOT_FOUND", "No run with that id is in the plugin's ledger.")
    if (terminal(run)) throw new ColabError("NOT_FOUND", "That run is not running, so there is nothing to cancel.", { next: "colab_execution shows its outputs and files." })

    const live = liveRun(runId)
    if (live && live.state() === "running") {
      await live.interrupt(input.restart === true ? "restart" : "interrupt")
      return {
        state: "ok" as const,
        runId,
        action: input.restart === true ? ("restarted" as const) : ("interrupted" as const),
        ...(input.restart === true ? { message: "The kernel was restarted; variables in memory are lost." } : {}),
      }
    }

    // A run this process no longer collects: reach its kernel through the session name the ledger's notebook gives.
    const record = run.runtime === undefined ? undefined : await runtimeOf(ctx, run.runtime)
    if (!record) throw new ColabError("NOT_FOUND", "The run names no runtime in the plugin's ledger.")
    // The record's own session name is exact; the fallbacks cover runs recorded before the contract amendment.
    const name = run.session ?? (run.notebook !== undefined ? sessionName(record, { notebook: run.notebook }) : await scratchSession(record, ctx))
    const session = await ctx.deps.runtime.openSession({ account: record.account, runtimeId: record.id }, { name, path: "/content" }, ctx.call.signal)
    if (input.restart === true) await session.restart(ctx.call.signal)
    else await session.interrupt(ctx.call.signal)
    await ctx.deps.ledger
      .putRun({ ...run, state: "cancelled", endedAt: ctx.deps.clock.now().toISOString() })
      .catch(() => undefined)
    return {
      state: "ok" as const,
      runId,
      action: input.restart === true ? ("restarted" as const) : ("interrupted" as const),
      message: input.restart === true ? "The kernel was restarted; variables in memory are lost." : "The kernel was interrupted.",
    }
  },
}

/** A detached scratch run: the one own, non-probe session left on the runtime, or a refusal that says why not. */
async function scratchSession(record: RuntimeRecord, ctx: HandlerContext): Promise<string> {
  const sessions = await ctx.deps.runtime.sessions({ account: record.account, runtimeId: record.id }, ctx.call.signal)
  const own = sessions.filter((session) => session.name.startsWith(`oc-${record.nonce}-`) && !session.name.endsWith("-probe"))
  if (own.length === 1 && own[0]) return own[0].name
  throw new ColabError("NOT_FOUND", "This run is no longer collected by the plugin process, and its session cannot be told apart from the runtime's other sessions.", {
    next: "The kernel-side watchdog still bounds it; colab_execution shows the files it wrote.",
  })
}
