/**
 * `colab_schedules` (design §6, §7.2): the account's Colab Enterprise schedules — cron with its time zone, state, the
 * next five runs, the runs started, the bounds — and each one's worst case: $/h × its own `executionTimeout` per run, and
 * that times the runs the cron gives in the next 30 days. A schedule another client created shows what its job request
 * says; when its machine is not in the dated price table, the costs are omitted rather than guessed.
 *
 * A schedule's cron, display name and state are Google text: `trust: "untrusted"`, names cut and redacted.
 */
import { OPERATIONS } from "../domain/actions.js"
import { ColabError } from "../domain/errors.js"
import type { OutputOf } from "../domain/contract.js"
import type { EnterpriseSchedule } from "../ports.js"
import type { ToolHandler } from "../tools/types.js"
import { cut, redact } from "../redact.js"
import type { ComputeSpec } from "./detail.js"
import { lastSegment } from "./ids.js"
import { nextRunsOf, scheduleCompute, scheduleCost, scheduleNameOf, settingsFor } from "./common.js"

export const schedulesHandler: ToolHandler<"schedules"> = {
  async run(input, ctx): Promise<OutputOf<"schedules">> {
    const settings = settingsFor(ctx, "colab_schedules")
    let schedules: readonly EnterpriseSchedule[]
    let truncated = false
    if (input.schedule === undefined) {
      await ctx.providerRead(OPERATIONS.schedulesList)
      const listed = await ctx.deps.vertex.listSchedules(ctx.account.alias, {}, ctx.call.signal)
      schedules = listed
      truncated = listed.truncated === true
    } else {
      await ctx.providerRead(OPERATIONS.schedulesGet)
      const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, scheduleNameOf(settings, input.schedule), ctx.call.signal)
      if (!schedule) throw new ColabError("NOT_FOUND", "The schedule was not found.", { next: "colab_schedules lists the account's schedules." })
      schedules = [schedule]
    }
    const cache = new Map<string, ComputeSpec>()
    const rows: {
      id: string
      displayName: string
      cron: string
      state: string
      nextRuns: string[]
      runsStarted?: number
      maxRunCount?: number
      endTime?: string
      worstCaseUsdPerRun?: number
      worstCaseUsdPerMonth?: number
    }[] = []
    for (const schedule of schedules.slice(0, 100)) {
      const compute = await scheduleCompute(ctx, schedule, cache)
      const cost = scheduleCost(schedule, ctx, compute)
      rows.push({
        id: lastSegment(schedule.name),
        displayName: cut(redact(schedule.displayName), 128),
        cron: cut(redact(schedule.cron), 256),
        state: schedule.state,
        nextRuns: nextRunsOf(schedule, ctx).map((date) => date.toISOString()),
        ...(schedule.startedRunCount !== undefined ? { runsStarted: schedule.startedRunCount } : {}),
        ...(schedule.maxRunCount !== undefined ? { maxRunCount: schedule.maxRunCount } : {}),
        ...(schedule.endTime !== undefined ? { endTime: schedule.endTime } : {}),
        ...(cost.perRun !== undefined ? { worstCaseUsdPerRun: Number(cost.perRun.toFixed(2)) } : {}),
        ...(cost.perMonth !== undefined ? { worstCaseUsdPerMonth: Number(cost.perMonth.toFixed(2)) } : {}),
      })
    }
    return { state: "ok", schedules: rows, trust: "untrusted", ...(truncated ? { warnings: ["OUTPUT_TRUNCATED" as const] } : {}) }
  },
}
