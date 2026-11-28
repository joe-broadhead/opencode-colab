/**
 * Package A, Auth: the Google credential behind every provider call, the sign-in form each integration offers, ADC,
 * impersonation and token mode, the local scope check, the session-control mapping, and `/colab-doctor`.
 *
 * `createAuth` builds the port `Deps` hands to every handler. The contract's `accounts` module registers one Agent
 * Platform MCP server per alias and `src/accounts.ts` attaches `authMethodsFor` to the integration the host gives it,
 * so this module never registers an integration.
 */
import { DISPLAY_NAME } from "../../constants.js"
import { ColabError } from "../../domain/errors.js"
import type { Auth, Clock } from "../ports.js"
import type { Options, ResolvedAccount } from "../../options.js"
import { clientFromOption, redirectMismatch, resolveClient, type ClientChoice } from "./client.js"
import { readSignIn, signInClient } from "./credential.js"
import { Doctor, type DoctorRuntimeProbe } from "./doctor.js"
import { integrationIdFor, integrationNames, readAnswer, signInForm, signInRedirect } from "./form.js"
import { authorizeGoogle, refreshGoogle, type GoogleAuthOptions } from "./google.js"
import { activeCredential, attachHost, type AuthHost, type HostConnection, type HostCredential } from "./host.js"
import { accountScopes } from "./scopes.js"
import { GoogleAuth, type GoogleAuthEnvironment } from "./token.js"

export interface AuthEnv extends GoogleAuthEnvironment {
  /** The runtime probe `/colab-doctor` uses; absent until the host wiring passes the provider, so the check is SKIPPED. */
  readonly doctorRuntimeProbe?: DoctorRuntimeProbe
}

/** The `Auth` port: `token`, `identity` and `scopes` for one account (src/provider/ports.ts). */
export function createAuth(env: AuthEnv): Auth {
  return new GoogleAuth(env)
}

// ── The host context, structurally ──────────────────────────────────────

interface Registration {
  dispose(): Promise<void>
}

interface CommandEditor {
  add(definition: { readonly name: string; readonly description?: string; readonly execute: (input: { readonly sessionID: string; readonly delivery: "steer" | "queue" }) => Promise<void> }): void
}

interface DoctorContext {
  readonly command: { transform(callback: (editor: CommandEditor) => void): Promise<Registration> }
  readonly permission: { assert(request: unknown): Promise<void> }
  readonly session: { synthetic(input: { readonly sessionID: string; readonly delivery: "steer" | "queue"; readonly text: string; readonly description: string; readonly resume: boolean }): Promise<void> }
}

const command = { name: "colab-doctor", description: `Check each ${DISPLAY_NAME} account's Google access with one small read each` }

/** Client precedence inputs for one account: its own option, the plugin option, the form, the previous sign-in. */
function configuredClients(options: Options, account: ResolvedAccount): { account?: ClientChoice; plugin?: ClientChoice; present: boolean } {
  const accountOption = account.oauthClient
  const pluginOption = options.oauthClient
  const parsedAccount = accountOption ? clientFromOption(accountOption) : undefined
  const parsedPlugin = pluginOption ? clientFromOption(pluginOption) : undefined
  return {
    ...(parsedAccount ? { account: { client: parsedAccount, source: "account" as const } } : {}),
    ...(parsedPlugin ? { plugin: { client: parsedPlugin, source: "plugin" as const } } : {}),
    present: Boolean(accountOption ?? pluginOption),
  }
}

async function previousClient(host: AuthHost, integrationID: string): Promise<ClientChoice | undefined> {
  const active = await activeCredential(host, integrationID)
  const signIn = active ? readSignIn(active.credential.metadata) : undefined
  return signIn ? signInClient(signIn) : undefined
}

/** The registration the contract's `accounts` module adds for one alias: the form, then the browser flow. */
export function authMethodsFor(options: Options, account: ResolvedAccount, integrationID: string, name: string, host: AuthHost, auth: GoogleAuthOptions) {
  const configured = configuredClients(options, account)
  const redirectOption = { ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}), ...(options.callbackPort !== undefined ? { callbackPort: options.callbackPort } : {}) }
  return {
    integrationID,
    method: { id: "google", type: "oauth", label: "Sign in with Google", form: signInForm(account.alias, account, resolveClient({ account: configured.account?.client, plugin: configured.plugin?.client }), redirectOption, configured.present) },
    authorize: async (raw: Record<string, unknown>) => {
      const answer = readAnswer(raw, account)
      const redirect = signInRedirect(answer.redirect, redirectOption)
      if (account.oauthClient && !configured.account) {
        throw new ColabError("AUTH_CLIENT_REQUIRED", `accounts.${account.alias}.oauthClient is not Google's client JSON or a client ID and secret.`, {
          next: `Set it to Google's downloaded Desktop client JSON, or "<clientId>:<clientSecret>".`,
        })
      }
      if (options.oauthClient && !configured.plugin) {
        throw new ColabError("AUTH_CLIENT_REQUIRED", "The oauthClient option is not Google's client JSON or a client ID and secret.", {
          next: `Set it to Google's downloaded client JSON, or "<clientId>:<clientSecret>".`,
        })
      }
      const previous = answer.pasted ? undefined : await previousClient(host, integrationID)
      const client = resolveClient({ account: configured.account?.client, plugin: configured.plugin?.client, ...(answer.pasted ? { pasted: answer.pasted } : {}), ...(previous ? { previous } : {}) })
      if (!client) {
        throw new ColabError("AUTH_CLIENT_REQUIRED", `No OAuth client is configured for ${account.alias}.`, {
          next: `Run /connect and choose ${name}, then enter your Desktop OAuth client ID and secret, or ask your administrator for oauthClient.`,
        })
      }
      const mismatch = redirectMismatch(client.client, redirect.uri || undefined)
      if (mismatch) {
        throw new ColabError("INPUT_INVALID", `Google would refuse this sign-in's redirect: ${mismatch}.`, {
          next: "Use a Desktop app client for a loopback redirect, or a Web application client whose registered redirect URIs include redirectUri exactly.",
        })
      }
      return authorizeGoogle({ alias: account.alias, name, client, access: answer.access, scopes: accountScopes(account, answer.access), redirect, options: auth })
    },
    refresh: async (credential: HostCredential) => {
      const refreshed = await refreshGoogle({
        alias: account.alias,
        name,
        credential: { type: "oauth", methodID: credential.methodID ?? "google", refresh: credential.refresh ?? "", access: credential.access ?? "", expires: credential.expires ?? 0, ...(credential.metadata ? { metadata: credential.metadata } : {}) },
        options: auth,
      })
      return refreshed as unknown as HostCredential
    },
    label: () => account.alias,
  }
}

/** Attach the host's credential store to this plugin instance; `GoogleAuth` reads the integration by its derived id. */
export function attachAuthHost(options: Options, host: AuthHost): () => void {
  return attachHost(options, host)
}

export { activeCredential, integrationIdFor, integrationNames }

/** `/colab-doctor`'s registration: one small read per account, through the host's own permission assert. */
export async function registerDoctor(ctx: unknown, env: AuthEnv): Promise<Registration> {
  const context = ctx as DoctorContext
  const doctor = new Doctor({
    options: env.options,
    auth: createAuth(env),
    ...(env.fetch ? { fetch: env.fetch } : {}),
    assert: (request) => context.permission.assert(request),
    ...(env.doctorRuntimeProbe ? { runtimeProbe: env.doctorRuntimeProbe } : {}),
  })
  return context.command.transform((editor) => {
    editor.add({
      ...command,
      execute: async ({ sessionID, delivery }) => {
        const answer = await doctor.run({ sessionID })
        await context.session.synthetic({ sessionID, delivery, text: answer.text, description: answer.description, resume: false })
      },
    })
  })
}

/** `/colab-doctor`'s command name, so status and docs do not spell it twice. */
export const DOCTOR_COMMAND = command.name

export type { AuthHost, HostConnection, HostCredential } from "./host.js"
