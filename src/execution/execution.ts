/**
 * `colab_execution` (design §6, §9): a run's state and outputs. Consumer runs come from this process's registry while
 * it collects them, and from `.colab/runs/<runId>/outputs.jsonl` after a restart — where the honest answer for a run
 * whose stream did not outlive the process is `state: "detached"` (design §9.4: output is not replayed to a new
 * connection). Enterprise jobs are package E's branch, reached through `deps.enterprise` with this call's
 * `ctx.providerRead`, so a person's `colab.read` rule fences every read it makes.
 */
import { join } from "node:path"
import type { InputOf } from "../domain/contract.js"
import { ColabError } from "../domain/errors.js"
import type { RunRecord } from "../ports.js"
import type { ToolHandler } from "../tools/types.js"
import { cellFromLine, readOutputs } from "./capture.js"
import { liveRun } from "./runs.js"
import { WAIT_SECONDS, waitForCompletion } from "./run.js"
import { shownPath } from "./support.js"

/** One page of a cell's full text, when `full: true` pages it (design §9.2's `…[cut]`/next pair). */
const PAGE_CHARS = 20_000

const pageOf = (text: string, page: number) => {
  const total = Math.ceil(Math.max(text.length, 1) / PAGE_CHARS)
  return { text: text.slice(page * PAGE_CHARS, (page + 1) * PAGE_CHARS), more: page + 1 < total }
}

const transcript = (record: RunRecord) =>
  record.state === "timeout"
    ? `The run hit its time bound and was interrupted; its files are in ${record.outputPaths[0] ?? "the run's folder"}.`
    : record.state === "cancelled"
      ? "The run was stopped."
      : record.state === "failed"
        ? `The run failed${record.errorCode ? ` (${record.errorCode})` : ""}.`
        : undefined

export const execution: ToolHandler<"execution"> = {
  async run(input: InputOf<"execution">, ctx) {
    if (input.job !== undefined) {
      // Package E owns the job branch: it asserts colab.read before each provider read it makes.
      const answer = await ctx.deps.enterprise.execution(
        ctx.account.alias,
        { job: input.job, ...(input.wait !== undefined ? { wait: input.wait } : {}), ...(input.cell !== undefined ? { cell: input.cell } : {}), ...(input.full !== undefined ? { full: input.full } : {}) },
        ctx.call.signal,
        ctx.providerRead,
      )
      return answer as never
    }
    const runId = input.runId!
    const record = await ctx.deps.ledger.getRun(runId)
    if (!record || record.account !== ctx.account.alias) throw new ColabError("NOT_FOUND", "No run with that id is in the plugin's ledger.", { next: "colab_status lists runs; a run's files are under the workDir's runs folder." })

    const live = liveRun(runId)
    const waitSec = Math.min(input.wait ?? 60, WAIT_SECONDS)
    if (live && live.state() === "running" && waitSec > 0) await waitForCompletion(live.done, waitSec * 1000, ctx.call.signal).catch(() => undefined)
    const state = live ? live.state() : record.state
    const detached = state === "running" && !live
    const captured = live ? live.cells() : (await readOutputs(join(ctx.deps.directory, ctx.deps.options.workDir, "runs", runId, "outputs.jsonl"))).flatMap((line) => {
      const cell = cellFromLine(line)
      return cell ? [cell] : []
    })

    let truncated = detached
    const page = input.page ?? 0
    const cells = captured
      .filter((cell) => input.cell === undefined || cell.id === input.cell)
      .map((cell) => {
        let stdout = cell.stdout
        let stderr = cell.stderr
        let result = cell.result
        if (input.full !== true && (cell.fullStdout !== cell.stdout || cell.fullStderr !== cell.stderr || cell.fullResult !== cell.result)) truncated = true
        if (input.full === true) {
          const out = pageOf(cell.fullStdout, page)
          const err = pageOf(cell.fullStderr, page)
          const res = cell.fullResult === undefined ? undefined : pageOf(cell.fullResult, page)
          stdout = out.text
          stderr = err.text
          if (res !== undefined) result = res.text
          truncated ||= out.more || err.more || (res?.more ?? false)
        }
        return {
          id: cell.id,
          state: cell.state,
          executionCount: cell.executionCount,
          ms: cell.ms,
          stdout,
          stderr,
          ...(result !== undefined ? { result } : {}),
          ...(cell.error ? { error: { ename: cell.error.ename, evalue: cell.error.evalue, traceback: [...cell.error.traceback] } } : {}),
          rich: [...cell.rich],
        }
      })
    if (input.cell !== undefined && cells.length === 0) throw new ColabError("NOT_FOUND", "The run has no cell with that id.")

    const answer = {
      state: state === "cancelled" ? ("cancelled" as const) : state === "running" ? (detached ? ("detached" as const) : ("running" as const)) : ("ok" as const),
      runId,
      ...(record.runtime ? { runtime: record.runtime } : {}),
      cells,
      files: [...record.outputPaths],
      ...(truncated ? { truncated } : {}),
      ...(transcript(record) && state !== "running" ? { message: transcript(record) } : {}),
      ...(state === "running" && !detached
        ? { next: `colab_execution({ runId: "${runId}", wait: 60 })` }
        : detached
          ? { next: `The run is no longer collected by this process (its code keeps running until it ends or its watchdog fires). Its files are under ${shownPath(join(ctx.deps.directory, ctx.deps.options.workDir, "runs", runId), ctx.deps.directory)} and /content/outputs on the runtime.` }
          : truncated
            ? { next: `colab_execution({ runId: "${runId}", cell: "<id>", full: true, page: 0 })` }
            : {}),
    }
    return answer as never
  },
}
