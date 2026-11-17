// Package B, Colab runtime transport (docs/v1-design.md, File ownership): the Colab API client (LRO, requestId,
// errors to codes), the runtime protocol (REST and the kernel WebSocket, token and URL checks, allow_stdin false, the
// colab_request decline, the watchdog) and the agent-only check (calibration, the kernel-side probe and its pinned
// colabtools facts, the REST fallback, nonce sessions, taint).
//
// The three pieces share one instance of the API client so a token refresh and the create join are seen by both, and the
// check talks to the runtime only through the protocol, so its every call passes the same "ours only" fence.
import type { PortEnv } from "../deps.js"
import type { AgentOnlyCheck, ColabApi, RuntimeProtocol } from "../ports.js"
import { createAgentOnlyCheck } from "./agentonly.js"
import { createColabApi } from "./api.js"
import { createRuntimeProtocol } from "./protocol.js"

export interface RuntimePorts {
  readonly colab: ColabApi
  readonly runtime: RuntimeProtocol
  readonly check: AgentOnlyCheck
}

export function createRuntimePorts(env: PortEnv): RuntimePorts {
  const colab = createColabApi(env)
  const runtime = createRuntimeProtocol(env, colab)
  const check = createAgentOnlyCheck(env, runtime)
  return { colab, runtime, check }
}

export { createColabApi } from "./api.js"
export { createRuntimeProtocol } from "./protocol.js"
export { createAgentOnlyCheck } from "./agentonly.js"
export { cancelWatchdog, startWatchdog, watchdogCancelSnippet, watchdogStartSnippet } from "./watchdog.js"
export { parseProbeOutput, probeSnippet, PROBE_SENTINEL, PROBE_SNIPPET_VERSION } from "./probe.js"
export { checkConnection, isAllowedRuntimeHost, safeUrl } from "./url.js"
