// Package B, Colab runtime transport (docs/v1-design.md, File ownership): the Colab API client (LRO, requestId,
// errors to codes), the runtime protocol (REST and the kernel WebSocket, token and URL checks, allow_stdin false, the
// colab_request decline, the watchdog) and the agent-only check (calibration, the kernel-side probe and its pinned
// colabtools version, the REST fallback, nonce sessions, taint). Day 0 stub: every method answers NOT_IMPLEMENTED.
import type { PortEnv } from "../deps.js"
import type { AgentOnlyCheck, ColabApi, RuntimeProtocol } from "../ports.js"
import { stubPort } from "../stub.js"

export interface RuntimePorts {
  readonly colab: ColabApi
  readonly runtime: RuntimeProtocol
  readonly check: AgentOnlyCheck
}

export function createRuntimePorts(_env: PortEnv): RuntimePorts {
  return { colab: stubPort<ColabApi>("ColabApi"), runtime: stubPort<RuntimeProtocol>("RuntimeProtocol"), check: stubPort<AgentOnlyCheck>("AgentOnlyCheck") }
}
