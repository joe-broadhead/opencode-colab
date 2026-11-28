/**
 * The provider: every port a handler reads through, built once per plugin instance.
 *
 * This is the only directory that names a Google host, an API path or a runtime binary. Handlers depend on the `Deps`
 * interface in `./ports.ts`; a test supplies the in-memory fakes under `test/fakes/`, so no test calls Google.
 */
import { createAuth } from "./auth/index.js"
import * as cost from "./cost/index.js"
import { createEnterprisePorts } from "./enterprise/index.js"
import { createRunEvents } from "./events.js"
import { FileLedger, ledgerDir } from "./ledger/store.js"
import * as notebookPackage from "./notebooks/index.js"
import type { Options } from "../options.js"
import type {
  AgentOnlyCheck,
  Auth,
  Budget,
  Clock,
  ColabApi,
  DriveApi,
  DriveSync,
  EnterpriseRuns,
  GcsApi,
  Ledger,
  NotebookStore,
  Prices,
  Release,
  RunEvents,
  RuntimeProtocol,
  VertexApi,
} from "./ports.js"
import { createRuntimePorts } from "./runtime/index.js"

/** The ports every handler receives. */
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

/** Build the provider. `fetch` is injectable so tests route every request to a loopback fake. */
export function createProvider(input: { readonly options: Options; readonly directory: string; readonly env?: NodeJS.ProcessEnv; readonly fetch?: typeof fetch; readonly integrationIDs?: ReadonlyMap<string, string> }): Deps {
  const clock: Clock = { now: () => new Date() }
  const ledger = new FileLedger(ledgerDir(input.env), { ledgerDays: input.options.ledgerDays, clock })
  const fetch = input.fetch ?? globalThis.fetch
  const auth = createAuth({ options: input.options, clock, fetch, ...(input.integrationIDs !== undefined ? { integrationIDs: input.integrationIDs } : {}) })
  const env: PortEnv = { options: input.options, directory: input.directory, clock, auth, ledger, fetch }
  const runtimePorts = createRuntimePorts(env)
  const enterprisePorts = createEnterprisePorts(env)
  const { notebooks, ...drivePorts } = notebookPackage.createNotebookPorts(env)
  const prices = enterprisePorts.prices
  return {
    options: input.options,
    directory: input.directory,
    clock,
    auth,
    ledger,
    events: createRunEvents(),
    ...runtimePorts,
    ...enterprisePorts,
    ...drivePorts,
    release: cost.createRelease(env, runtimePorts),
    budget: cost.createBudget(env, prices),
    prices,
    notebooks,
  }
}
