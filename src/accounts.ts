/**
 * The account layer: the profile schema the manifest declares, the one integration per alias, and the status rows.
 *
 * OpenCode owns sign-in; the contract's `accounts` module names and registers the integrations. This module supplies
 * only what the plugin knows: the Google auth methods for an alias, and the profile defaults the provider reads.
 */
import type { Plugin } from "@opencode/plugin"
import { accountName, accountsOf, registerAccounts } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { PLUGIN_NAME } from "./constants.js"
import type { Manifest } from "./manifest.js"
import { loadOptions, type Options, type ResolvedAccount } from "./options.js"
import { attachAuthHost, authMethodsFor, integrationNames } from "./provider/auth/index.js"
import type { AuthHost, HostConnection, HostCredential } from "./provider/auth/host.js"

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

/**
 * Register one integration per alias. A transform failure is returned in `problems` (status shows it), never thrown:
 * a machine with no credential still loads.
 */
export async function registerColabAccounts(
  ctx: Pick<Plugin.Context, "integration" | "mcp">,
  input: { readonly manifest: Manifest; readonly rawOptions: Readonly<Record<string, unknown>>; readonly options: Options; readonly host: AuthHost },
) {
  const detach = attachAuthHost(input.options, input.host)
  const names = integrationNames(input.options.accounts)
  const byAlias = new Map(input.options.accounts.map((account) => [account.alias, account]))
  const auth = (account: { readonly alias: string }, integrationID: string) => {
    const resolved = byAlias.get(account.alias)
    if (resolved === undefined) return []
    return [authMethodsFor(input.options, resolved, integrationID, names.get(account.alias) ?? "Colab", input.host, { now: () => Date.now() })]
  }
  const registration = await registerAccounts(ctx, { manifest: input.manifest, options: input.rawOptions, auth })
  return { registration, detach }
}

/** The aliases the manifest and options declare, and their resolved profiles. */
export function accountsFor(manifest: Manifest, rawOptions: Readonly<Record<string, unknown>>): readonly ResolvedAccount[] {
  const plan = accountsOf(manifest, rawOptions)
  if (!plan.ok) return []
  return loadOptions(rawOptions).accounts.filter((account) => plan.value.accounts.some((entry) => entry.alias === account.alias))
}

/** The integration id an alias uses: `colab` for default, `colab-<alias>` otherwise. */
export const integrationIDFor = (alias: string): string => accountName(PLUGIN_NAME, alias)

export type { AuthHost, HostConnection, HostCredential }
