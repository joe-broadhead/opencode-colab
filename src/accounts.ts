/**
 * The account layer: the profile schema the manifest declares, one Agent Platform MCP server per alias, the plugin's
 * Google sign-in on each server's integration, and the status rows.
 *
 * OpenCode owns sign-in; the contract's `accounts` module names and registers the servers (mechanism `mcp`, §5). This
 * module supplies only what the plugin knows: the server config, the Google auth method for an interactive alias, and
 * the profile defaults the provider reads. A headless profile (adc, token) registers its server but signs in to
 * nothing: its own calls use application default credentials or the token variable, as before.
 */
import type { Plugin } from "@opencode/plugin"
import { accountLabel, accountName, accountsOf, registerAccounts, type AccountsRegistration } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { PLUGIN_NAME } from "./constants.js"
import type { Manifest } from "./manifest.js"
import { loadOptions, type Options, type ResolvedAccount } from "./options.js"
import { attachAuthHost, authMethodsFor, integrationNames } from "./provider/auth/index.js"
import type { AuthHost, HostConnection, HostCredential } from "./provider/auth/host.js"
import { notebookMcpServer } from "./provider/notebook-mcp.js"

/** The profile's fields, each optional so `{}` is a valid profile. */
export const PROFILE_SCHEMA = {
  type: "object",
  description: "One profile per account alias; every field is optional.",
  properties: {
    backend: { type: "string", enum: ["colab", "enterprise"], default: "colab", description: "colab for a consumer runtime, enterprise for Colab Enterprise jobs and schedules." },
    mode: { type: "string", enum: ["interactive", "adc", "token"], default: "interactive", description: "interactive signs in with Google; adc uses application default credentials; token reads an environment variable." },
    access: { type: "string", enum: ["read", "write"], description: "read refuses every change on this account; write allows plans and commits." },
    drive: { type: "boolean", description: "Whether Drive notebooks are read and pushed on this account." },
    project: { type: "string", minLength: 1, description: "The Google Cloud project for an enterprise account." },
    region: { type: "string", minLength: 1, description: "The Vertex AI region for an enterprise account." },
    outputBucket: { type: "string", pattern: "^gs://[^/]+(?:/.*)?$", description: "The gs:// bucket and prefix Enterprise jobs write their output notebook to." },
    serviceAccount: { type: "string", format: "email", description: "The service account an Enterprise job runs as." },
    runAsUser: { type: "boolean", default: false, description: "Run Enterprise jobs as the signed-in user instead of a service account." },
    oauthClient: { type: "string", description: "This account's OAuth client: Google's downloaded client JSON, or <clientId>:<clientSecret>." },
    scopes: { type: "array", items: { type: "string", minLength: 1 }, description: "Extra OAuth scopes to request at sign-in." },
    tokenEnv: { type: "string", pattern: "^[A-Z_][A-Z0-9_]*$", description: "The environment variable holding an access token in token mode." },
    impersonate: { type: "string", format: "email", description: "A service account to impersonate with application default credentials." },
    budget: {
      type: "object",
      description: "The account's optional daily budget.",
      properties: {
        enterpriseUsdDaily: { type: "number", exclusiveMinimum: 0 },
        runtimeHoursDaily: { type: "number", exclusiveMinimum: 0 },
        action: { type: "string", enum: ["warn", "refuse"], default: "warn" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
} as const

/** One status row per alias, in the order the options name them. */
export interface AccountSignal {
  readonly state: "ready" | "needs_sign_in" | "error"
  readonly owner?: { readonly id: string; readonly label: string }
  readonly reason?: string
}

/** The part of `ctx.integration.transform`'s editor this module uses, so host types stay in setup. */
interface IntegrationEditor {
  get(id: string): { readonly id: string; name: string } | undefined
  update(id: string, update: (integration: { readonly id: string; name: string }) => void): void
  readonly method: {
    list(id: string): readonly { readonly id: string; readonly type: string }[]
    remove(id: string, method: { readonly id: string }): void
    update(input: Readonly<Record<string, unknown>>): void
  }
}

/** The parts of the host context account registration needs. */
type AccountsContext = Pick<Plugin.Context, "integration" | "mcp" | "event">

/** What registering the servers and attaching the plugin's sign-in did, and what it could not. */
export interface ColabAccounts {
  readonly registration: AccountsRegistration
  /** alias → the integration id that holds the alias's sign-in, which the provider reads at call time. */
  readonly integrationIDs: Map<string, string>
  problems(): readonly string[]
  detach(): Promise<void>
}

const MCP_STARTUP_POLL_MS = 250
const MCP_STARTUP_WINDOW_MS = 10_000
const MCP_RESUBSCRIBE_MS = 5_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** Calls `handle` for each event of `types` until `signal` aborts or the stream ends. */
async function forEachIntegrationEvent(
  subscribe: Plugin.Context["event"]["subscribe"],
  signal: AbortSignal,
  handle: () => void,
): Promise<void> {
  const iterator = subscribe({ types: ["integration.updated"], signal })[Symbol.asyncIterator]()
  let stop = () => {}
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
  })
  signal.addEventListener("abort", stop, { once: true })
  try {
    while (!signal.aborted) {
      const result = await Promise.race([iterator.next(), aborted])
      if (!result || result.done) return
      handle()
    }
  } finally {
    signal.removeEventListener("abort", stop)
    void iterator.return?.()?.catch(() => undefined)
  }
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}

/**
 * Register one Agent Platform MCP server per alias and put the plugin's Google sign-in on each interactive alias's
 * server integration.
 *
 * OpenCode creates a server's integration after `registerAccounts` returns, so the attach is retried for a short
 * startup window and again whenever an integration changes. A failure is recorded for status, never thrown: a server
 * whose sign-in could not be attached still appears, and status names the problem.
 *
 * The server's own generic OAuth method is removed: Google Cloud requires an OAuth client configured for the MCP
 * server, and the plugin's form is where the person enters it. The integration the host gives the server is the one
 * the plugin's own reads resolve, so an interactive account signs in once.
 */
export async function registerColabAccounts(
  ctx: AccountsContext,
  input: { readonly manifest: Manifest; readonly rawOptions: Readonly<Record<string, unknown>>; readonly options: Options; readonly host: AuthHost; readonly integrationIDs?: Map<string, string>; readonly problems?: string[] },
): Promise<ColabAccounts> {
  const detachHost = attachAuthHost(input.options, input.host)
  const names = integrationNames(input.options.accounts)
  const byAlias = new Map(input.options.accounts.map((account) => [account.alias, account]))
  const servers = new Map(input.options.accounts.map((account) => [account.alias, accountName(PLUGIN_NAME, account.alias)]))
  const integrationIDs = input.integrationIDs ?? new Map<string, string>()
  for (const [alias, name] of servers) if (!integrationIDs.has(alias)) integrationIDs.set(alias, name)
  const registration = await registerAccounts(ctx, {
    manifest: input.manifest,
    options: input.rawOptions,
    server: () => notebookMcpServer(),
  })
  const problems = input.problems ?? []
  problems.push(...registration.problems)
  const stopped = new AbortController()
  const attached = new Map<string, { readonly id: string; dispose: () => Promise<void> }>()

  const serverIntegration = async (name: string): Promise<string | undefined> => {
    try {
      return (await ctx.mcp.list()).data.find((server) => server.name === name)?.integrationID
    } catch {
      return undefined
    }
  }

  const genericReturned = async (id: string): Promise<boolean> => {
    try {
      const { data } = await ctx.integration.get({ integrationID: id })
      return data.methods.some((method) => method.type === "oauth" && method.id !== "google")
    } catch {
      return false
    }
  }

  const attach = async (alias: string, name: string): Promise<void> => {
    const account = byAlias.get(alias)
    if (account === undefined || account.mode !== "interactive") return
    const id = await serverIntegration(name)
    if (id === undefined || stopped.signal.aborted) return
    const held = attached.get(alias)
    if (held?.id === id && !(await genericReturned(id))) return
    const method = authMethodsFor(input.options, account, id, names.get(alias) ?? "Colab", input.host, { now: () => Date.now() })
    const next = await ctx.integration.transform((raw: unknown) => {
      const editor = raw as IntegrationEditor
      // The host creates the server's integration after setup; the poller retries until it exists.
      if (editor.get(id) === undefined) return
      editor.update(id, (integration) => {
        integration.name = accountLabel(input.manifest.plugin.title, alias)
      })
      for (const listed of editor.method.list(id)) {
        if (listed.type === "oauth" && listed.id !== "google") editor.method.remove(id, listed)
      }
      editor.method.update({ ...method, integrationID: id })
    })
    integrationIDs.set(alias, id)
    const previous = attached.get(alias)
    attached.set(alias, { id, dispose: () => next.dispose() })
    await previous?.dispose().catch(() => undefined)
  }

  let checking: Promise<void> | undefined
  let again = false
  const check = async (): Promise<void> => {
    for (const [alias, name] of servers) {
      if (stopped.signal.aborted) return
      try {
        await attach(alias, name)
      } catch (error) {
        const reason = `accounts.${alias}: the Agent Platform MCP server's sign-in could not be attached: ${messageOf(error)}`
        if (!problems.includes(reason)) problems.push(reason)
      }
    }
  }
  const schedule = (): Promise<void> => {
    if (checking) {
      again = true
      return checking
    }
    checking = (async () => {
      do {
        again = false
        if (!stopped.signal.aborted) await check().catch(() => undefined)
      } while (again)
    })().finally(() => {
      checking = undefined
    })
    return checking
  }

  const listen = (async () => {
    while (!stopped.signal.aborted) {
      await forEachIntegrationEvent(ctx.event.subscribe, stopped.signal, () => void schedule()).catch(() => undefined)
      if (!stopped.signal.aborted) void schedule()
      await wait(MCP_RESUBSCRIBE_MS, stopped.signal)
    }
  })()
  const startup = (async () => {
    const until = Date.now() + MCP_STARTUP_WINDOW_MS
    while (!stopped.signal.aborted && Date.now() < until) {
      await schedule()
      await wait(MCP_STARTUP_POLL_MS, stopped.signal)
    }
  })()
  // The host may already have the server's integration when a reload registers the accounts; attach before returning.
  await schedule()

  return {
    registration,
    integrationIDs,
    problems: () => problems,
    async detach() {
      stopped.abort()
      await Promise.allSettled([startup, listen])
      for (const entry of attached.values()) await entry.dispose().catch(() => undefined)
      detachHost()
    },
  }
}

/** The aliases the manifest and options declare, and their resolved profiles. */
export function accountsFor(manifest: Manifest, rawOptions: Readonly<Record<string, unknown>>): readonly ResolvedAccount[] {
  const plan = accountsOf(manifest, rawOptions)
  if (!plan.ok) return []
  return loadOptions(rawOptions).accounts.filter((account) => plan.value.accounts.some((entry) => entry.alias === account.alias))
}

/** The base server name an alias uses: `colab` for default, `colab-<alias>` otherwise. */
export const integrationIDFor = (alias: string): string => accountName(PLUGIN_NAME, alias)

export type { AuthHost, HostConnection, HostCredential }
