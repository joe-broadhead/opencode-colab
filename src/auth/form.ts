/**
 * The sign-in form OpenCode renders before authentication starts, and how its answer is read (design §4; gws's form,
 * extended with the account's backend and levels).
 *
 * The form is host-agnostic: the fields are structural twins of OpenCode's `Form.Fields`, so this module never imports
 * the host, and `registerAuth` hands them over. Every level shows the exact scope URLs it requests, before Google's own
 * consent screen; anything but an explicit `write` answer signs in read-only.
 *
 * Three hidden fields are for a host to fill, never shown:
 * - `clientJson`, Google's downloaded client JSON, which Jelly supplies as this plugin's host client
 *   (`package.json` `jelly.signIns[0].hostClient`);
 * - `redirectUri` and `callbackPort`, the relay of a host that serves OpenCode to a browser on another machine.
 * The plugin options are their defaults. A configured client puts nothing secret in the form: the two client fields
 * are hidden and left blank, and the configured client is used.
 */
import { DISPLAY_NAME, INTEGRATION_PREFIX } from "../constants.js"
import { ColabError } from "../domain/errors.js"
import type { ResolvedAccount } from "../options.js"
import { clientFromJson, desktopClient, isClientId, isClientSecret, type ClientChoice, type OAuthClient } from "./client.js"
import { redirectProblem, resolveRedirect, type Redirect } from "./redirect.js"
import { accountScopes, shortScopes, writeScopes, type SignInLevel } from "./scopes.js"

export interface FormOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface FormCondition {
  readonly key: string
  readonly op: "eq" | "neq"
  readonly value: string | number | boolean
}

/** One form field; the host's own `Form.Field` union accepts each shape. */
export interface FormField {
  readonly key: string
  readonly type: "string" | "boolean" | "integer"
  readonly title?: string
  readonly description?: string
  readonly required?: boolean
  readonly hidden?: boolean
  readonly when?: readonly FormCondition[]
  readonly placeholder?: string
  readonly pattern?: string
  readonly default?: string | number | boolean
  readonly options?: readonly FormOption[]
  readonly minimum?: number
  readonly maximum?: number
}

export type SignInForm = readonly FormField[]

export interface RedirectConfig {
  readonly redirectUri?: string
  readonly callbackPort?: number
}

/** The integration id for one account: `colab-<alias>` (design §4, `package.json` `jelly.signIns[0].integration`). */
export function integrationIdFor(alias: string): string {
  return `${INTEGRATION_PREFIX}${alias}`
}

/**
 * The name `/connect` shows: "Colab", plus the alias when more than one interactive account can sign in. Headless
 * accounts (adc, token) have no sign-in and no integration.
 */
export function integrationNames(accounts: readonly Pick<ResolvedAccount, "alias" | "mode">[]): Map<string, string> {
  const interactive = accounts.filter((account) => account.mode === "interactive")
  return new Map(interactive.map((account) => [account.alias, interactive.length > 1 ? `${DISPLAY_NAME} (${account.alias})` : DISPLAY_NAME]))
}

const WHERE =
  "From a Desktop app OAuth client: Google Cloud console → Google Auth platform → Clients. A Web application client works only with a redirect URI the host sets. /colab-status lists the steps."

/** A host-checked pattern: the value's format, or blank. */
const pattern = (source: string): string => `^\\s*$|${source}`

/**
 * Write is offered only to an account configured `access: "write"`: the setting is the fence that keeps a read account
 * from writing (design §4), so the form cannot widen it.
 */
function offersWrite(account: ResolvedAccount): boolean {
  return account.access === "write"
}

function accessOptions(account: ResolvedAccount): FormOption[] {
  const read = { value: "read", label: "Read-only", description: `Requests: ${accountScopes(account, "read").join(" ")}` }
  if (!offersWrite(account)) return [read]
  const write = { value: "write", label: "Read and write", description: `Requests: ${accountScopes(account, "write").join(" ")}` }
  return [read, write]
}

/**
 * The client fields. A configured client (the account's, the plugin's) hides both with no default, so no secret enters
 * the form or the host's form event; the sign-in uses the configured client. Otherwise they are visible for a one-time
 * paste, and left blank the sign-in reuses the client entered at this account's previous sign-in.
 */
function clientFields(configured: boolean): [FormField, FormField] {
  const hidden = configured
  const description = hidden
    ? "Configured with oauthClient; the sign-in uses it and this field is not shown."
    : `The OAuth client ID. ${WHERE} Leave both blank to reuse the client from this account's previous sign-in.`
  return [
    {
      key: "clientId",
      type: "string",
      title: "OAuth client ID",
      description,
      required: false,
      ...(hidden ? { hidden: true } : { placeholder: "…apps.googleusercontent.com", pattern: pattern("^[A-Za-z0-9-]+\\.apps\\.googleusercontent\\.com$") }),
    },
    {
      key: "clientSecret",
      type: "string",
      title: "OAuth client secret",
      description: hidden ? "Configured with oauthClient; kept with the sign-in." : "The secret of the same Desktop app client. Google treats an installed app's secret as non-confidential; it is kept with the sign-in in OpenCode's credential store.",
      required: false,
      ...(hidden ? { hidden: true } : { placeholder: "GOCSPX-…", pattern: pattern("^[A-Za-z0-9_-]+$") }),
    },
  ]
}

/**
 * The form: the client, the access choice (each option lists the exact scope URLs it requests), the write
 * acknowledgment when write asks for more than read, and the host's three hidden fields.
 */
export function signInForm(alias: string, account: ResolvedAccount, configured: ClientChoice | undefined, redirect: RedirectConfig = {}, clientConfigured = configured !== undefined): SignInForm {
  const extra = writeScopes(account)
  const fields: FormField[] = [
    ...clientFields(clientConfigured),
    {
      key: "clientJson",
      type: "string",
      title: "OAuth client JSON",
      description: 'Google\'s downloaded client JSON, {"installed": …} or {"web": …}. A host fills it (Jelly provides its Google client this way); it replaces the client ID and secret. Kept with the sign-in in OpenCode\'s credential store.',
      required: false,
      hidden: true,
    },
    {
      key: "access",
      type: "string",
      title: "Access",
      description:
        account.backend === "enterprise"
          ? `${alias} uses Colab Enterprise (a Google Cloud project). Enterprise has no read-only scope: both levels request cloud-platform, which reaches more than this plugin's access level.`
          : `${alias} uses your own Colab and its compute units. Read-only cannot create or delete Colab runtimes; running code on a runtime the plugin created is not fenced by the scope.`,
      required: true,
      default: account.access,
      options: accessOptions(account),
    },
    ...(extra.length > 0 && offersWrite(account)
      ? [
          {
            key: "confirmWrite",
            type: "boolean" as const,
            title: `I understand this grants write access to: ${shortScopes(extra).join(", ")}`,
            description: "Agents can then create and delete runtimes, jobs and schedules, upload files and push Drive notebooks; each change is a plan or an ask under the plugin's access setting.",
            required: true,
            default: false,
            when: [{ key: "access", op: "eq" as const, value: "write" }],
          },
        ]
      : []),
    {
      key: "redirectUri",
      type: "string",
      title: "OAuth redirect URI",
      description: "The absolute URL Google redirects to after consent, when the browser is not on this machine. Needs callbackPort. Blank: a loopback redirect.",
      required: false,
      hidden: true,
      pattern: "^\\s*$|^https?://\\S+$",
      ...(redirect.redirectUri !== undefined ? { default: redirect.redirectUri } : {}),
    },
    {
      key: "callbackPort",
      type: "integer",
      title: "OAuth callback port",
      description: "The port on 127.0.0.1 where the redirect reaches the sign-in's listener.",
      required: false,
      hidden: true,
      minimum: 1,
      maximum: 65_535,
      ...(redirect.callbackPort !== undefined ? { default: redirect.callbackPort } : {}),
    },
  ]
  return fields
}

const text = (answer: Readonly<Record<string, unknown>>, key: string): string => {
  const value = answer[key]
  if (value === undefined || value === null) return ""
  if (typeof value !== "string") throw new ColabError("INPUT_INVALID", `The sign-in form's ${key} answer is not text.`, { next: "Run /connect again and enter the OAuth client." })
  return value.trim()
}

function enteredClient(answer: Readonly<Record<string, unknown>>): OAuthClient | undefined {
  const json = text(answer, "clientJson")
  if (json) {
    const client = clientFromJson(json)
    if (!client) {
      throw new ColabError("INPUT_INVALID", "The OAuth client JSON is not Google's downloaded client JSON.", {
        next: 'Pass the file Google Cloud console downloads for the client: {"installed": …} for a Desktop app, or {"web": …} with redirect_uris for a Web application.',
      })
    }
    return client
  }
  const clientId = text(answer, "clientId")
  const clientSecret = text(answer, "clientSecret")
  if (!clientId && !clientSecret) return undefined
  if ((clientId && !isClientId(clientId)) || (clientSecret && !isClientSecret(clientSecret)) || !clientId || !clientSecret) {
    throw new ColabError("INPUT_INVALID", "The OAuth client needs both a client ID (…apps.googleusercontent.com) and its secret, and both must be well formed.", {
      next: "Enter both from the same Desktop app OAuth client, or ask your administrator for oauthClient.",
    })
  }
  const client = desktopClient(clientId, clientSecret)
  if (!client) throw new ColabError("INPUT_INVALID", "The OAuth client ID or secret is not well formed.", { next: "Enter both from the same Desktop app OAuth client." })
  return client
}

function enteredRedirect(answer: Readonly<Record<string, unknown>>): RedirectConfig {
  const redirectUri = text(answer, "redirectUri")
  const raw = answer["callbackPort"]
  let callbackPort: number | undefined
  if (typeof raw === "number") callbackPort = raw
  else if (typeof raw === "string" && raw.trim()) callbackPort = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
  else if (raw !== undefined && raw !== null && raw !== "") callbackPort = Number.NaN
  return { ...(redirectUri ? { redirectUri } : {}), ...(callbackPort !== undefined ? { callbackPort } : {}) }
}

export interface SignInAnswer {
  /** The client entered in the form, if any. */
  readonly pasted?: OAuthClient
  readonly access: SignInLevel
  /** What the host filled in; the options are its defaults, applied by the caller. */
  readonly redirect: RedirectConfig
}

/**
 * Read a submitted form. A half-entered client, a bad redirect and an unacknowledged write are refused here, before
 * any network call or listener.
 */
export function readAnswer(answer: Readonly<Record<string, unknown>>, account: ResolvedAccount): SignInAnswer {
  const pasted = enteredClient(answer)
  const redirect = enteredRedirect(answer)
  const problem = redirect.redirectUri ? redirectProblem(redirect.redirectUri) : undefined
  if (problem) throw new ColabError("INPUT_INVALID", `The sign-in redirect ${problem}.`, { next: "Set redirectUri to an absolute https URL, or leave it unset for a loopback redirect." })
  if (redirect.callbackPort !== undefined && (!Number.isInteger(redirect.callbackPort) || redirect.callbackPort < 1 || redirect.callbackPort > 65_535)) {
    throw new ColabError("INPUT_INVALID", "The sign-in callbackPort is not a port from 1 to 65535.", { next: "Set callbackPort to the local port the redirect reaches, or leave it unset." })
  }
  const access: SignInLevel = answer["access"] === "write" ? "write" : "read"
  if (access === "write" && !offersWrite(account)) {
    throw new ColabError("INPUT_INVALID", `The account ${account.alias} is configured read-only, so this sign-in cannot ask for write access.`, {
      next: `Set accounts.${account.alias}.access to "write" in opencode.json if this account should be able to change anything, then sign in again.`,
    })
  }
  if (access === "write" && writeScopes(account).length > 0 && answer["confirmWrite"] !== true) {
    throw new ColabError("INPUT_INVALID", "Write access was chosen without the acknowledgment.", {
      next: "Sign in again and confirm the write scopes, or choose Read-only.",
    })
  }
  return { ...(pasted ? { pasted } : {}), access, redirect }
}

/** A resolved redirect for this sign-in: the host's answer wins over its option, which is only the field's default. */
export function signInRedirect(entered: RedirectConfig, option: RedirectConfig): Redirect {
  return resolveRedirect({ redirectUri: entered.redirectUri ?? option.redirectUri, callbackPort: entered.callbackPort ?? option.callbackPort })
}
