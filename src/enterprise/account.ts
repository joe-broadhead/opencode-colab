/**
 * What an Enterprise call needs from an account before anything reaches Google (design §4, §7.4, §9): an `enterprise`
 * backend, a project and region, an output bucket for a job or schedule, and a run identity — a `serviceAccount`, or
 * the person only when `runAsUser: true` (Q9). Every refusal is raised here, before the network.
 */
import { ColabError } from "../domain/errors.js"
import type { Options, ResolvedAccount } from "../options.js"
import type { Auth, Identity } from "../ports.js"
import { gcsParts } from "./ids.js"

/** The scopes a Vertex AI notebook call and a bucket read take. L3 decides whether the narrower pair replaces these. */
export const ENTERPRISE_SCOPES = ["https://www.googleapis.com/auth/cloud-platform"] as const
// TODO(L3): if the notebook REST methods accept `aiplatform` + `devstorage.read_only` (the notebook MCP's scope), the
// enterprise sign-in becomes that pair instead of cloud-platform; §4 and the jelly scope list change with it.

export interface EnterpriseSettings {
  readonly alias: string
  readonly project: string
  readonly region: string
  /** `gs://bucket`: the account's output bucket alone. */
  readonly outputBucket?: string
  /** The configured `outputBucket` with its path and a trailing slash: every result goes in a folder under it. */
  readonly outputBase?: string
  readonly serviceAccount?: string
  readonly runAsUser: boolean
  readonly budget?: ResolvedAccount["budget"]
}

export interface EnterpriseEnv {
  readonly options: Options
  readonly auth: Auth
}

export const parentOf = (settings: EnterpriseSettings) => `projects/${settings.project}/locations/${settings.region}`

/**
 * The locational Vertex AI endpoint for an account's region. Google says to "specify the location for an Agent Platform
 * API request by using the appropriate locational endpoint … to make a request in the us-central1 region, use
 * https://us-central1-aiplatform.googleapis.com" (https://docs.cloud.google.com/vertex-ai/docs/general/locations), and
 * its Colab Enterprise sample sets `{LOCATION}-aiplatform.googleapis.com`
 * (https://docs.cloud.google.com/colab/docs/schedule-notebook-run). The REST reference lists the global host and each
 * regional host as service endpoints
 * (https://docs.cloud.google.com/vertex-ai/docs/reference/rest/v1/projects.locations.notebookExecutionJobs/create).
 */
export const vertexHost = (settings: EnterpriseSettings) => `https://${settings.region}-aiplatform.googleapis.com/v1/`

/** A location such as us-central1, europe-west4 or asia-east1. */
const LOCATION = /^[a-z]+(?:-[a-z]+)*\d+$/

/** Asserts the account is an Enterprise one with a project and region; `what` names the call for the message. */
export function enterpriseSettings(env: EnterpriseEnv, alias: string, what: string, options: { readonly bucket?: boolean } = {}): EnterpriseSettings {
  const account = env.options.accounts.find((entry) => entry.alias === alias)
  if (!account) throw new ColabError("ACCOUNT_UNKNOWN", `No account is named "${alias}".`)
  if (account.backend !== "enterprise") {
    throw new ColabError("ACTION_UNSUPPORTED", `The account "${alias}" is a consumer Colab account; ${what} needs a Colab Enterprise account.`, {
      next: "Pass account with an enterprise backend (colab_status lists them), or add one to the plugin's accounts option.",
    })
  }
  if (!account.project || !account.region) {
    throw new ColabError("PROJECT_REQUIRED", `The enterprise account "${alias}" has no ${account.project ? "region" : "project"}.`, {
      next: `Set accounts.${alias}.project and accounts.${alias}.region in opencode.json.`,
    })
  }
  if (!LOCATION.test(account.region)) {
    throw new ColabError("OPTIONS_INVALID", `The enterprise account "${alias}" has the region "${account.region}", which is not a location such as us-central1.`, {
      next: `Set accounts.${alias}.region to a location whose endpoint is <region>-aiplatform.googleapis.com.`,
    })
  }
  let outputBucket: string | undefined
  let outputBase: string | undefined
  if (account.outputBucket) {
    const parts = gcsParts(account.outputBucket)
    outputBucket = `gs://${parts.bucket}`
    outputBase = account.outputBucket.endsWith("/") ? account.outputBucket : `${account.outputBucket}/`
  } else if (options.bucket) {
    throw new ColabError("BUCKET_REQUIRED", `The enterprise account "${alias}" has no outputBucket, so a job's results have nowhere to go.`, {
      next: `Set accounts.${alias}.outputBucket to a gs:// bucket you can read, such as gs://my-colab-results.`,
    })
  }
  return {
    alias,
    project: account.project,
    region: account.region,
    ...(outputBucket !== undefined ? { outputBucket } : {}),
    ...(outputBase !== undefined ? { outputBase } : {}),
    ...(account.serviceAccount !== undefined ? { serviceAccount: account.serviceAccount } : {}),
    runAsUser: account.runAsUser,
    ...(account.budget !== undefined ? { budget: account.budget } : {}),
  }
}

export interface RunIdentity {
  readonly as: "serviceAccount" | "user"
  readonly serviceAccount?: string
  readonly executionUser?: string
  /** What the preview shows: the service account's email, or `you (<email>)`. */
  readonly label: string
}

/**
 * The identity an Enterprise job runs as (design §7.4, Q9): the account's `serviceAccount`, or the person with
 * `runAsUser: true` (which the preview says plainly), else `RUN_IDENTITY_REQUIRED`.
 */
export async function runIdentity(env: EnterpriseEnv, settings: EnterpriseSettings, kind: "job" | "schedule", signal: AbortSignal): Promise<RunIdentity> {
  if (settings.serviceAccount) return { as: "serviceAccount", serviceAccount: settings.serviceAccount, label: settings.serviceAccount }
  if (!settings.runAsUser) {
    throw new ColabError("RUN_IDENTITY_REQUIRED", `The ${kind} plan needs a run identity: the account has no serviceAccount and runAsUser is false.`, {
      next: `Set accounts.${settings.alias}.serviceAccount (recommended) to an account with the roles in docs/auth.md, or runAsUser: true to run as you.`,
    })
  }
  const identity: Identity | undefined = await env.auth.identity(settings.alias, signal)
  if (!identity) {
    throw new ColabError("AUTH_REQUIRED", `runAsUser: true needs your signed-in email for executionUser, and the account has no identity.`, {
      next: `Sign in again with /connect and the Colab Enterprise account "${settings.alias}".`,
    })
  }
  return { as: "user", executionUser: identity.email, label: `you (${identity.email})` }
}
