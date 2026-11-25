/**
 * `cleanup`: release the idle and tainted runtimes of the plugin's own on one account, through the one release
 * function. A run recorded running, or a create that never finished, is reported and left alone. The command `/colab`
 * runs the same work for every alias.
 */
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { cleanupActions, cleanupReport, type CleanupDeps } from "../provider/cost/cleanup.js"
import type { Deps } from "../provider/index.js"
import { assertWritable, providerAccount } from "./context.js"
import { mapped } from "./errors.js"

const INPUT = { type: "object", properties: {}, additionalProperties: false }
const OUTPUT = {
  type: "object",
  properties: {
    report: { type: "string" },
    released: { type: "array", items: { type: "string" } },
    blocked: { type: "array", items: { type: "string" } },
    failed: { type: "array", items: { type: "object", additionalProperties: true } },
  },
  required: ["report", "released", "blocked", "failed"],
  additionalProperties: false,
}

/** The cleanup deps for one account's provider. */
export function cleanupDeps(deps: Deps): CleanupDeps {
  return { options: deps.options, ledger: deps.ledger, release: deps.release, clock: deps.clock }
}

export function cleanupHandler(deps: Deps): MethodHandler {
  return {
    description: "Release the idle or tainted Colab runtimes of the plugin's own on an account, and report what costs money. Enterprise runtimes are listed by runtimes_read and stopped by a plan.",
    input: INPUT,
    output: OUTPUT,
    async run(_input, call) {
      return mapped(async () => {
        const account = providerAccount(deps, call.account)
        assertWritable(account)
        const now = deps.clock.now()
        const actions = (await cleanupActions(cleanupDeps(deps), now)).filter((action) => action.record.account === account.alias)
        const released: string[] = []
        const blocked: string[] = []
        const failed: { runtime: string; code: string }[] = []
        for (const action of actions) {
          if (action.blocked) {
            blocked.push(action.record.id)
            continue
          }
          try {
            const answer = await deps.release.release(action.record, { reason: "plan", force: false }, call.signal)
            if (answer.released) released.push(action.record.id)
          } catch (error) {
            failed.push({ runtime: action.record.id, code: typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "UNAVAILABLE" })
          }
        }
        if (released.length > 0) await call.bus.emit("changed", { capability: "colab.runtimes", account: account.alias, reason: "write" })
        return { report: cleanupReport(cleanupDeps(deps), actions, now), released, blocked, failed }
      })
    },
  }
}
