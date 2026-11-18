/**
 * Colab's part of the tools RPC (`google-colab.tools`): the plugin value and the method table that the source
 * contract's `tools-rpc` module takes. The module (`@we-the-rebel-alliance/source-contract/tools-rpc`, tag v0.2.0,
 * bundled into `dist/index.js`) is the transport every plugin of the family shares:
 *
 *   POST /api/rpc/google-colab.tools/<method>
 *   { "input": { "sessionID": "<session>", "input": <the tool's input> } }
 *
 * A script runs as a session and the agent it names; the rule for the method's permission action is resolved before
 * dispatch, and only `allow` runs. The methods are the twelve read tools, run through the same wrapper as the model's
 * tools (src/tools/spec.ts), and the source contract's `probe`. Write, export and destructive tools are never methods.
 */
import type { Failure, MethodSpec, NextSteps, ToolsRpcPlugin } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { toolsRpcId } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID, STATUS_COMMAND } from "./constants.js"
import { TOOLS } from "./domain/actions.js"
import type { ToolName } from "./domain/contract.js"
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import { ColabError } from "./domain/errors.js"
import { sourceMethods } from "./sources/index.js"
import { type Runner, scriptMethod } from "./tools/spec.js"

/** The RPC's id: the plugin's id and `.tools`. package.json `sources.rpc` names it; scripts call it by name. */
export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

/** The read tools, in design §6's order, then the source probe. */
export const METHOD_NAMES: readonly string[] = [...TOOLS.filter((tool) => tool.class === "read").map((tool) => tool.name), "probe"]

export function methods(runner: Runner): readonly MethodSpec[] {
  // The probe reads accounts and the ledger through the runner, as the read methods do (colab-15 request 2).
  return [...TOOLS.filter((tool) => tool.class === "read").map((tool) => scriptMethod(tool.name as ToolName, runner)), ...(sourceMethods as (runner: Runner) => readonly MethodSpec[])(runner)]
}

/** The next step for each code the module itself raises. Each is one sentence that ends with a full stop. */
export const NEXT_STEPS: NextSteps = {
  SESSION_UNKNOWN: `Create a session in the location you mean, such as POST /api/session with {"agent":"build"} sent with the header "x-opencode-directory: <dir>" or the location[directory] query, and pass its id.`,
  SESSION_AGENT_REQUIRED: `Create a session that names an agent this project has, with its project as the location, such as POST /api/session with {"agent":"build","location":{"directory":"/path/to/project"}}, and pass its id.`,
  PERMISSION_DENIED: "Add an allow rule for the method's action to the session's agent or to the session, or use a session whose agent allows it.",
  CANCELLED: "Call the method again if you still need the result.",
  ACCOUNT_UNKNOWN: `Pass an account alias that /${STATUS_COMMAND} lists.`,
}

/** The plugin's own errors, thrown by a method, as a code, what happened and the next step. */
export function pluginError(error: unknown): Failure | undefined {
  // A source read's refusal is the contract's own code (colab-15 request 3), before the plugin's.
  if (error instanceof SourceError) return { code: error.code, what: error.what, next: error.next, ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}) } as Failure
  return ColabError.is(error) ? { code: error.code, what: error.detail.replace(/\.$/, ""), next: error.next } : undefined
}

export const PLUGIN: ToolsRpcPlugin = { id: PLUGIN_ID, nextSteps: NEXT_STEPS, pluginError }
