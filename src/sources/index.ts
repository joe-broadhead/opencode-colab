// Package G, Sources (docs/v1-design.md, File ownership): colab_events_list (colab.runs, from the ledger),
// colab_runtimes_read (colab.runtimes), the source contract's `probe` method, and `npm run conformance`. Day 0 stubs
// answer NOT_IMPLEMENTED; the probe method is declared so the tools RPC lists it.
import type { JsonSchema, PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PROBE_ACTION } from "../domain/actions.js"
import { notImplemented } from "../stub.js"
import type { ToolHandlers } from "../tools/types.js"

export const HANDLERS: ToolHandlers = {
  events_list: { run: async () => notImplemented("colab_events_list") },
  runtimes_read: { run: async () => notImplemented("colab_runtimes_read") },
}

const OBJECT: JsonSchema = { type: "object" }

/** The source contract's probe: names the signed-in account, reads no content; asserts `colab.probe` only. */
export function sourceMethods(): PluginMethod[] {
  return [
    {
      kind: "plugin",
      name: "probe",
      action: PROBE_ACTION,
      class: "read",
      description: "Names the signed-in account for a source; reads no content.",
      input: OBJECT,
      output: OBJECT,
      run: async () => notImplemented("The source probe"),
    },
  ]
}
