/**
 * The one object every handler receives: each port, built by the package that owns it (docs/v1-design.md, File
 * ownership). Day 0 wires real implementations for the ledger, the plan store, run events and the clock, and each
 * package's factory for the rest; until a package lands, its factory returns a stub whose every method answers
 * NOT_IMPLEMENTED. Tests build a Deps from test/fakes/ instead.
 */
import { createAuth } from "./auth/index.js"
import { createEnterprisePorts } from "./enterprise/index.js"
import * as cost from "./cost/index.js"
import { PlanStore } from "./domain/plans.js"
import { createRunEvents } from "./events.js"
import { FileLedger, ledgerDir } from "./ledger/store.js"
import * as notebookPackage from "./notebooks/index.js"
import type { Options } from "./options.js"
import type { AgentOnlyCheck, Auth, Budget, Clock, ColabApi, DriveApi, DriveSync, EnterpriseRuns, GcsApi, Ledger, NotebookStore, PlanStorePort, Prices, Release, RunEvents, RuntimeProtocol, VertexApi } from "./ports.js"
import { createRuntimePorts } from "./runtime/index.js"
import { NO_NOTEBOOKS, NO_PRICES, OK_BUDGET } from "./stub.js"

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
  readonly budget: Budget
  readonly enterprise: EnterpriseRuns
  readonly prices: Prices
  readonly driveSync: DriveSync
  readonly notebooks: NotebookStore
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
  // C may rename its factory createDrivePorts → createNotebookPorts and add `notebooks` to what it returns.
  const notebookFactory =
    optionalMember<(env: PortEnv) => { readonly drive: DriveApi; readonly driveSync: DriveSync; readonly notebooks?: NotebookStore }>(notebookPackage, "createNotebookPorts") ??
    optionalMember<(env: PortEnv) => { readonly drive: DriveApi; readonly driveSync: DriveSync; readonly notebooks?: NotebookStore }>(notebookPackage, "createDrivePorts")!
  const { notebooks, ...drivePorts } = notebookFactory(env)
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
    release: cost.createRelease(env, runtimePorts),
    // Optional factories, so F, E and C add them in their own files without a Day 0 change: F exports `createBudget`
    // from src/cost/index.ts, E's `createEnterprisePorts` returns `prices`, and C's factory returns `notebooks`.
    // Until then, Day 0's stubs.
    budget: optionalMember<(env: PortEnv) => Budget>(cost, "createBudget")?.(env) ?? OK_BUDGET,
    prices: optionalMember<Prices>(enterprisePorts, "prices") ?? NO_PRICES,
    notebooks: notebooks ?? NO_NOTEBOOKS,
  }
}

/** A member a package may or may not export yet. */
function optionalMember<T>(source: object, key: string): T | undefined {
  return (source as Record<string, unknown>)[key] as T | undefined
}
