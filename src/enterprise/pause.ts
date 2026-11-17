/**
 * `colab_pause` (design §6, §7.1): pause an Enterprise schedule. Pausing is a direct change — no run is lost and no
 * money is committed — so it is not a plan; resuming restarts recurring cost and is one (`schedule.resume`).
 *
 * The schedule state is output-only (unspecified, active, paused or completed); the pause method is
 * `schedules.pause` and needs no request body (Vertex v1 discovery revision 20261107). A schedule that already finished
 * cannot be paused, and the tool refuses rather than reporting a state Google did not set.
 */
import { OPERATIONS } from "../domain/actions.js"
import { ColabError } from "../domain/errors.js"
import type { OutputOf } from "../domain/contract.js"
import type { ToolHandler } from "../tools/types.js"
import { lastSegment } from "./ids.js"
import { scheduleNameOf, settingsFor } from "./common.js"

export const pauseHandler: ToolHandler<"pause"> = {
  async run(input, ctx): Promise<OutputOf<"pause">> {
    const settings = settingsFor(ctx, "colab_pause")
    await ctx.providerRead(OPERATIONS.schedulesGet)
    const schedule = await ctx.deps.vertex.getSchedule(ctx.account.alias, scheduleNameOf(settings, input.schedule), ctx.call.signal)
    if (!schedule) throw new ColabError("NOT_FOUND", "The schedule was not found.", { next: "colab_schedules lists the account's schedules." })
    const id = lastSegment(schedule.name)
    // The contract's PauseOutput reuses `state` for the schedule's state, so the runtime schema wants "PAUSED"; the
    // inferred type sees `state?: undefined` (a Day 0 schema quirk recorded as a contract request).
    if (schedule.state === "PAUSED") return { state: "PAUSED", schedule: id, message: "The schedule was already paused." } as unknown as OutputOf<"pause">
    if (schedule.state === "COMPLETED") {
      throw new ColabError("ACTION_UNSUPPORTED", "The schedule has completed, so there is nothing to pause.", { next: "colab_schedules lists its runs; plan schedule.create for a new one." })
    }
    await ctx.deps.vertex.pauseSchedule(ctx.account.alias, schedule.name, ctx.call.signal)
    return { state: "PAUSED", schedule: id } as unknown as OutputOf<"pause">
  },
}
