/**
 * Package A, Auth (docs/v1-design.md, File ownership): the `colab-<alias>` integrations and their form, PKCE, the
 * relay, client precedence and `id_token`; ADC, impersonation and token mode for enterprise accounts; the local scope
 * check; the session-control mapping; `/colab-doctor`.
 *
 * `createAuth` builds the port `Deps` hands to every tool and source. `registerAuth` is the host registration the
 * plugin's `setup` calls: it attaches OpenCode's credential store to this instance (before that it has no host
 * context), registers one OAuth integration per interactive account, and registers `/colab-doctor`.
 *
 * The host is typed structurally (`host.ts`, `AuthContext` below) so this module imports no private host package; the
 * public plugin API is the only boundary, and the smoke test H10 loads the built plugin in a real host.
 */
import { DISPLAY_NAME, INTEGRATION_PREFIX } from "../constants.js"
import { ColabError } from "../domain/errors.js"
import type { Auth, Clock } from "../ports.js"
import type { Options, ResolvedAccount } from "../options.js"
import { clientFromOption, redirectMismatch, resolveClient, type ClientChoice } from "./client.js"
import { readSignIn, signInClient } from "./credential.js"
import { Doctor, type DoctorRuntimeProbe } from "./doctor.js"
import { integrationIdFor, integrationNames, readAnswer, signInForm, signInRedirect } from "./form.js"
import { authorizeGoogle, refreshGoogle, type GoogleAuthOptions } from "./google.js"
import { activeCredential, attachHost, type AuthHost, type HostConnection, type HostCredential } from "./host.js"
import { accountScopes } from "./scopes.js"
import { GoogleAuth, type GoogleAuthEnvironment } from "./token.js"

export interface AuthEnv extends GoogleAuthEnvironment {
  /** The runtime probe `/colab-doctor` uses; absent until the host wiring passes `Deps`, so the check is SKIPPED. */
  readonly doctorRuntimeProbe?: DoctorRuntimeProbe
}

/** The `Auth` port: `token`, `identity` and `scopes` for one account (src/ports.ts). */
export function createAuth(env: AuthEnv): Auth {
  return new GoogleAuth(env)
}

// ── The host context, structurally ──────────────────────────────────────

interface Registration {
  dispose(): Promise<void>
}

interface IntegrationRef {
  id: string
  name: string
}

interface IntegrationDraft {
  list(): readonly IntegrationRef[]
  get(id: string): IntegrationRef | undefined
  update(id: string, update: (integration: IntegrationRef) => void): void
}

interface FormMethodRegistration {
  readonly integrationID: string
  readonly method: { readonly id: string; readonly type: "oauth"; readonly label: string; readonly form: readonly unknown[] }
  readonly authorize: (answer: Record<string, unknown>) => Promise<unknown>
  readonly refresh: (credential: HostCredential) => Promise<HostCredential>
  readonly label?: (credential: HostCredential) => string | undefined
}

interface CommandEditor {
  add(definition: { readonly name: string; readonly description?: string; readonly execute: (input: { readonly sessionID: string; readonly delivery: "steer" | "queue" }) => Promise<void> }): void
}

interface AuthContext {
  readonly integration: {
    transform(callback: (draft: IntegrationDraft & { readonly method: { update(input: FormMethodRegistration): void } }) => void): Promise<Registration>
    readonly connection: {
      active(integrationID: string): Promise<HostConnection | undefined>
      resolve(connection: HostConnection): Promise<HostCredential | undefined>
      status?(input: { readonly integrationID: string; readonly connection: HostConnection; readonly status: { readonly status: "needs_auth"; readonly message: string } | undefined }): Promise<void>
    }
  }
  readonly command: {
    transform(callback: (editor: CommandEditor) => void): Promise<Registration>
  }
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

/** The sign-in method of one interactive account: the form, then the browser flow with exactly the answer's scopes. */
function integrationFor(options: Options, account: ResolvedAccount, name: string, host: AuthHost, auth: GoogleAuthOptions) {
  const configured = configuredClients(options, account)
  const redirectOption = { ...(options.redirectUri !== undefined ? { redirectUri: options.redirectUri } : {}), ...(options.callbackPort !== undefined ? { callbackPort: options.callbackPort } : {}) }
  const integrationID = integrationIdFor(account.alias)
  return {
    integrationID,
    name,
    form: signInForm(account.alias, account, resolveClient({ account: configured.account?.client, plugin: configured.plugin?.client }), redirectOption, configured.present),
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
          next: `Set it to Google's downloaded Desktop client JSON, or "<clientId>:<clientSecret>".`,
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

/**
 * The host registrations A owns: one OAuth integration per interactive account, and `/colab-doctor`. Headless accounts
 * have no sign-in and no integration.
 */
export async function registerAuth(ctx: unknown, env: AuthEnv): Promise<{ dispose(): Promise<void> }> {
  const context = ctx as AuthContext
  const host: AuthHost = {
    active: (integrationID) => context.integration.connection.active(integrationID),
    resolve: (connection) => context.integration.connection.resolve(connection),
    ...(context.integration.connection.status
      ? { report: async (integrationID: string, connection: HostConnection, message: string) => void (await context.integration.connection.status!({ integrationID, connection, status: { status: "needs_auth", message } })) }
      : {}),
  }
  const detach = attachHost(env.options, host)
  const registrations: Registration[] = []
  const authOptions: GoogleAuthOptions = { ...(env.fetch ? { fetch: env.fetch } : {}), now: () => env.clock.now().getTime() }
  try {
    const names = integrationNames(env.options.accounts)
    const interactive = env.options.accounts.filter((account) => account.mode === "interactive")
    if (interactive.length > 0) {
      registrations.push(
        await context.integration.transform((draft) => {
          for (const account of interactive) {
            const definition = integrationFor(env.options, account, names.get(account.alias) ?? DISPLAY_NAME, host, authOptions)
            draft.update(definition.integrationID, (integration) => {
              integration.name = definition.name
            })
            draft.method.update({
              integrationID: definition.integrationID,
              method: { id: "google", type: "oauth", label: "Sign in with Google", form: definition.form },
              authorize: definition.authorize,
              refresh: definition.refresh,
              label: definition.label,
            })
          }
        }),
      )
    }
    const doctor = new Doctor({
      options: env.options,
      auth: createAuth(env),
      ...(env.fetch ? { fetch: env.fetch } : {}),
      assert: (request) => context.permission.assert(request),
      ...(env.doctorRuntimeProbe ? { runtimeProbe: env.doctorRuntimeProbe } : {}),
    })
    registrations.push(
      await context.command.transform((editor) => {
        editor.add({
          ...command,
          execute: async ({ sessionID, delivery }) => {
            const answer = await doctor.run({ sessionID })
            await context.session.synthetic({ sessionID, delivery, text: answer.text, description: answer.description, resume: false })
          },
        })
      }),
    )
    return {
      async dispose() {
        detach()
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      },
    }
  } catch (cause) {
    detach()
    for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    throw cause
  }
}

/** `/colab-doctor`'s command name, so status and docs do not spell it twice. */
export const DOCTOR_COMMAND = command.name
