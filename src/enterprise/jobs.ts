/**
 * `colab_jobs` (design §6): the account's Colab Enterprise execution jobs — state, timings, compute, the schedule that
 * started it and its error — from `notebookExecutionJobs.list`.
 *
 * The read is the API's view, not a local history: L13 records how long Google keeps a finished job, and until it runs
 * the plugin does not claim a retention window. A job's display name and error are Google text, so the result is
 * `trust: "untrusted"`, cut and redacted.
 */
import { OPERATIONS } from "../domain/actions.js"
import { ColabError } from "../domain/errors.js"
import type { OutputOf } from "../domain/contract.js"
import type { ToolHandler } from "../tools/types.js"
import { cut, redact } from "../redact.js"
import { acceleratorShort } from "./prices.js"
import { lastSegment } from "./ids.js"
import type { JobDetail } from "./detail.js"
import { settingsFor } from "./common.js"

const computeOf = (job: JobDetail): string | undefined => {
  if (job.machineType) return `${job.machineType}${job.acceleratorType ? ` + ${acceleratorShort(job.acceleratorType)}` : ""}`
  if (job.template) return `template ${lastSegment(job.template)}`
  return undefined
}

export const jobsHandler: ToolHandler<"jobs"> = {
  async run(input, ctx): Promise<OutputOf<"jobs">> {
    settingsFor(ctx, "colab_jobs")
    const since = input.since === undefined ? undefined : Date.parse(input.since)
    if (input.since !== undefined && !Number.isFinite(since)) throw new ColabError("INPUT_INVALID", "since is not a date the plugin can read.", { next: "Pass an RFC 3339 time, such as 2026-11-17T00:00:00Z." })
    await ctx.providerRead(OPERATIONS.jobsList)
    const jobs = await ctx.deps.vertex.listJobs(ctx.account.alias, { pageSize: 100 }, ctx.call.signal)
    const rows = jobs
      .filter((job) => since === undefined || (job.createTime !== undefined && Date.parse(job.createTime) >= since))
      .filter((job) => input.state === undefined || job.state === input.state)
      .sort((a, b) => (b.createTime ?? "").localeCompare(a.createTime ?? ""))
      .slice(0, input.limit ?? 20)
      .map((job) => ({
        id: lastSegment(job.name),
        displayName: cut(redact(job.displayName), 128),
        state: job.state,
        ...(job.createTime !== undefined ? { created: job.createTime } : {}),
        ...(job.endTime !== undefined ? { ended: job.endTime } : {}),
        ...(computeOf(job) !== undefined ? { compute: computeOf(job)! } : {}),
        ...(job.schedule !== undefined ? { schedule: lastSegment(job.schedule) } : {}),
        ...(job.error !== undefined ? { error: cut(redact(job.error), 300) } : {}),
      }))
    return { state: "ok", jobs: rows, trust: "untrusted" }
  },
}
