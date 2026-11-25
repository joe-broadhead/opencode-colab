/**
 * The one handler table `register` wires through doors 1–3. Every declared method has exactly one entry; the register
 * refuses a missing or an undeclared one. Provider work lives in `./provider.ts`, sources in `./sources.ts`, plans in
 * `./plan.ts`, and the two contract-wide answers in `./status.ts` and `./probe.ts`.
 */
import type { HandlerTable } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Manifest } from "../manifest.js"
import type { Deps } from "../provider/index.js"
import type { ResolvedAccount } from "../options.js"
import { cleanupHandler } from "./cleanup.js"
import { providerHandlers } from "./provider.js"
import { deleteHandler, planDeleteHandler, planWriteHandler, writeHandler } from "./plan.js"
import { probeHandler } from "./probe.js"
import { eventsListHandler, runtimesReadHandler } from "./sources.js"
import { statusHandler } from "./status.js"

export interface HandlerParts {
  readonly deps: Deps
  readonly manifest: Manifest
  readonly version: string
  readonly hostVersion: string
  readonly profiles: readonly ResolvedAccount[]
  readonly problems: readonly string[]
}

export function createHandlers(parts: HandlerParts): HandlerTable {
  return {
    status: statusHandler(parts),
    probe: probeHandler(parts.deps),
    ...providerHandlers(parts.deps),
    events_list: eventsListHandler(parts.deps),
    runtimes_read: runtimesReadHandler(parts.deps),
    plan_write: planWriteHandler(parts.deps),
    plan_delete: planDeleteHandler(parts.deps),
    write: writeHandler(parts.deps),
    delete: deleteHandler(parts.deps),
    cleanup: cleanupHandler(parts.deps),
  }
}
