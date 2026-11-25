/**
 * `probe`: names the signed-in owner of an account and the scopes its sign-in holds, and reads no content.
 *
 * `colab.runs` is this computer's ledger, so its owner is local. `colab.runtimes` is the Google account, so its owner
 * is the verified email or the plugin's synthetic id. A missing credential is `NEEDS_SIGN_IN`, never an empty owner.
 */
import { probeResult, PROBE_SCHEMA, type ProbeResult } from "@we-the-rebel-alliance/plugin-contract/events"
import type { MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Deps } from "../provider/index.js"
import { googleOwner, localOwner } from "../provider/owner.js"
import { providerAccount } from "./context.js"
import { mapped } from "./errors.js"

const INPUT = {
  type: "object",
  properties: { source: { type: "string", enum: ["runs", "runtimes"], description: "Which source's owner to name; runtimes by default." } },
  additionalProperties: false,
}

export function probeHandler(deps: Deps): MethodHandler {
  return {
    description: "Name the owner of an account for colab.runs (this computer) or colab.runtimes (the Google account), and the scopes held. It reads no content.",
    input: INPUT,
    output: PROBE_SCHEMA,
    async run(input, call): Promise<ProbeResult> {
      return mapped(async () => {
        const source = input.source === "runs" ? "runs" : "runtimes"
        const account = providerAccount(deps, call.account)
        if (source === "runs") return probeResult({ source, account: account.alias, owner: localOwner() })
        const owner = await googleOwner(deps, account, call.signal)
        const scopes = account.mode === "interactive" ? await deps.auth.scopes(account.alias) : []
        return probeResult({ source, account: account.alias, owner }, scopes.length > 0 ? { scopes: [...scopes] } : {})
      })
    },
  }
}
