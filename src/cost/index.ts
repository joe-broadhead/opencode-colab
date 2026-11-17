// Package F, Cost, cleanup, status (docs/v1-design.md, File ownership): the automation owner, the Jupyter idle rule,
// harvest-then-release (the one release function), budgets, the cost and cleanup blocks, the hooks, colab_status,
// `/colab-cleanup`, and the status RPC and TUI (src/rpc.ts, src/status.ts, src/tui/). Day 0 stubs answer
// NOT_IMPLEMENTED and register nothing.
import type { PortEnv } from "../deps.js"
import type { Release } from "../ports.js"
import type { RuntimePorts } from "../runtime/index.js"
import { notImplemented } from "../stub.js"
import type { ToolHandlers } from "../tools/types.js"

export const HANDLERS: ToolHandlers = {
  status: { run: async () => notImplemented("colab_status") },
}

export function createRelease(_env: PortEnv, _runtime: RuntimePorts): Release {
  return { release: async () => notImplemented("Releasing a runtime") }
}

/** The host registrations F owns (automation, hooks, `/colab-cleanup`). Day 0 registers nothing. */
export async function registerCost(_ctx: unknown, _deps: unknown): Promise<{ dispose(): Promise<void> }> {
  return { dispose: async () => undefined }
}
