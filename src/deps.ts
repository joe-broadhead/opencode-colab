/**
 * The one object every handler receives: each port, built by the package that owns it (docs/v1-design.md, File
 * ownership). Day 0 wires real implementations for the ledger, the plan store, run events and the clock, and each
 * package's factory for the rest; until a package lands, its factory returns a stub whose every method answers
 * NOT_IMPLEMENTED. Tests build a Deps from test/fakes/ instead.
 */
import { createAuth } from "./auth/index.js"
import { createEnterprisePorts } from "./enterprise/index.js"
import { createRelease } from "./cost/index.js"
import { PlanStore } from "./domain/plans.js"
import { createRunEvents } from "./events.js"
import { FileLedger, ledgerDir } from "./ledger/store.js"
import { createDrivePorts } from "./notebooks/index.js"
import type { Options } from "./options.js"
import type { AgentOnlyCheck, Auth, Clock, ColabApi, DriveApi, DriveSync, EnterpriseRuns, GcsApi, Ledger, PlanStorePort, Release, RunEvents, RuntimeProtocol, VertexApi } from "./ports.js"
import { createRuntimePorts } from "./runtime/index.js"

export interface Deps {
  readonly options: Options
  /** The project directory: workDir, local notebooks and downloads resolve inside it. */
  readonly directory: string
  readonly clock: Clock
  readonly auth: Auth
  readonly colab: ColabApi
  readonly runtime: RuntimeProtocol
  readonly check: AgentOnlyCheck
  readonly vertex: VertexApi
  readonly drive: DriveApi
  readonly gcs: GcsApi
  readonly ledger: Ledger
  readonly plans: PlanStorePort
  readonly events: RunEvents
  readonly release: Release
  readonly enterprise: EnterpriseRuns
  readonly driveSync: DriveSync
}

/** What a package's port factory may use: the options, the clock, credentials, the ledger and the network. */
export interface PortEnv {
  readonly options: Options
  readonly directory: string
  readonly clock: Clock
  readonly auth: Auth
  readonly ledger: Ledger
  readonly fetch: typeof fetch
}

export function createDeps(input: { readonly options: Options; readonly directory: string; readonly env?: NodeJS.ProcessEnv; readonly fetch?: typeof fetch }): Deps {
  const clock: Clock = { now: () => new Date() }
  const ledger = new FileLedger(ledgerDir(input.env), { ledgerDays: input.options.ledgerDays, clock })
  const auth = createAuth({ options: input.options, clock })
  const env: PortEnv = { options: input.options, directory: input.directory, clock, auth, ledger, fetch: input.fetch ?? globalThis.fetch }
  const runtimePorts = createRuntimePorts(env)
  const enterprisePorts = createEnterprisePorts(env)
  const drivePorts = createDrivePorts(env)
  return {
    options: input.options,
    directory: input.directory,
    clock,
    auth,
    ledger,
    plans: new PlanStore(input.options.planTtlSeconds),
    events: createRunEvents(),
    ...runtimePorts,
    ...enterprisePorts,
    ...drivePorts,
    release: createRelease(env, runtimePorts),
  }
}
