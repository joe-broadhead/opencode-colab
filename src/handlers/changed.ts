/**
 * The one place a successful change names the capability it nudges (contract §4.7). `changed` is emitted after every
 * non-read method and every commit, and the capability is a logical area an app re-reads, not necessarily a source:
 * `colab.runs` and `colab.runtimes` are sources, while notebooks, schedules and files are app areas.
 */
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"

/** The capability a change to `action` affects; every non-read method and every plan action must map. */
export function changedCapability(action: string): string {
  if (action.startsWith("runtime.") || action === "upload" || action === "cleanup") return "colab.runtimes"
  if (action.startsWith("job.") || action === "run" || action === "cancel") return "colab.runs"
  if (action.startsWith("schedule.") || action === "pause") return "colab.schedules"
  if (action.startsWith("drive.") || action === "edit") return "colab.notebooks"
  // An export: it changes only files in the project, so it nudges the app's file area rather than a provider source.
  if (action === "download") return "colab.files"
  throw new Error(`changed: no capability for ${action}`)
}

/** Emit the one `changed` nudge for a successful change, with the account and the action as the short reason. */
export async function emitChanged(call: MethodCall, account: string, action: string): Promise<void> {
  await call.bus.emit("changed", { capability: changedCapability(action), account, reason: action })
}
