/**
 * `/colab-doctor` (design §14): one small read per account that proves the credential, the scopes, the API and the IAM
 * a person needs, and, except at read-only, a two-second `print(1)` on a running runtime of the plugin's own.
 *
 * Checks, with the operation each asserts as `colab.read` on `<account>:<operation>`:
 * - consumer: `runtimespecs.list` (Colab API v1beta revision 20261115, `GET v1beta/runtimespecs`);
 * - enterprise: `notebookRuntimeTemplates.list` (`GET v1/projects/{project}/locations/{region}/notebookRuntimeTemplates`)
 *   and one bucket listing (`GET storage/v1/b/{bucket}/o`, Cloud Storage JSON API);
 * - the runtime probe, asserted as `colab.run`, exactly as a run is (`runResources`).
 *
 * Every answer is one of design §14's codes, built from HTTP status and Google's reason markers, never from Google's
 * text: a status line or a message may reach the model, and Google's words are untrusted (design §7.3). A check that a
 * person's rule or reply denies is `DENIED` and takes no further action.
 */
import { ColabError, type ErrorCode } from "../domain/errors.js"
import { OPERATIONS, operationResource, READ_ACTION, runResources, type Operation } from "../domain/actions.js"
import type { Auth } from "../ports.js"
import { redact } from "../redact.js"
import type { Options, ResolvedAccount } from "../options.js"
import { googleFetch } from "./google.js"
import { SCOPES, widerThanAccess } from "./scopes.js"

/** A check's result: design §14's codes, plus DENIED, SKIPPED and the plugin's own account codes. */
export type DoctorStatus = "OK" | "SKIPPED" | "DENIED" | "ERROR" | ErrorCode

export interface DoctorCheck {
  readonly account: string
  readonly backend: "colab" | "enterprise"
  readonly check: string
  readonly status: DoctorStatus
  /** Our own sentence: what happened, never Google's text. */
  readonly detail?: string
  /** One concrete next step, when there is one. */
  readonly next?: string
  /** For API_DISABLED: the console link that enables the API. */
  readonly enableUrl?: string
}

/**
 * The two-second run on a runtime of the plugin's own. The runtime protocol and the ledger behind it are not part of
 * the sign-in registration in this version, so this is a seam the host wiring can fill; absent, the check is SKIPPED
 * and says so.
 */
export interface DoctorRuntimeProbe {
  /** Consumer runtime ids this plugin created for the account, from its ledger. */
  readonly runtimes: (account: string) => Promise<readonly string[]>
  /** Opens a plugin session on the runtime and runs `print(1)` with a two-second budget. */
  readonly print: (account: string, runtime: string, signal: AbortSignal) => Promise<void>
}

export interface DoctorEnvironment {
  readonly options: Options
  readonly auth: Auth
  /** A test's fetch; production uses `globalThis.fetch` through the allow-list. */
  readonly fetch?: typeof globalThis.fetch
  /** The host's `permission.assert`, for `colab.read` and `colab.run`. */
  readonly assert?: (request: { readonly sessionID: string; readonly action: string; readonly resources: readonly string[]; readonly metadata: Readonly<Record<string, unknown>> }) => Promise<void>
  readonly runtimeProbe?: DoctorRuntimeProbe
  readonly signal?: AbortSignal
}

const SPECS_URL = "https://colaboratory.googleapis.com/v1beta/runtimespecs?pageSize=1"
const templatesUrl = (account: ResolvedAccount): string =>
  `https://aiplatform.googleapis.com/v1/projects/${encodeURIComponent(account.project ?? "")}/locations/${encodeURIComponent(account.region ?? "")}/notebookRuntimeTemplates?pageSize=1`
const bucketUrl = (bucket: string): string => {
  const match = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(bucket)
  if (!match) return ""
  const prefix = match[2] ? `&prefix=${encodeURIComponent(match[2])}` : ""
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(match[1]!)}/o?maxResults=1${prefix}`
}
const enableUrl = (api: string): string => `https://console.cloud.google.com/flows/enableapi?apiid=${api}`

interface Answer {
  readonly ok: boolean
  readonly status: number
  /** Google's own reason markers, used for classification only; never shown. */
  readonly disabled: boolean
  readonly quota: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value)

async function get(url: string, token: string, fetchImpl: typeof globalThis.fetch, signal: AbortSignal | undefined): Promise<Answer> {
  let response: Response
  try {
    response = await googleFetch(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, ...(signal ? { signal } : {}) }, fetchImpl)
  } catch (error) {
    if (signal?.aborted) throw new ColabError("CANCELLED")
    throw new ColabError("UNAVAILABLE", "Google could not be reached from this machine.")
  }
  let text = ""
  try {
    text = await response.text()
  } catch {
    /* a bodyless answer is fine */
  }
  const markers = text.slice(0, 20_000)
  return {
    ok: response.ok,
    status: response.status,
    disabled: /SERVICE_DISABLED|accessNotConfigured|has not been used in project|API is not enabled/i.test(markers),
    quota: response.status === 429 || /RESOURCE_EXHAUSTED|rateLimitExceeded|quotaExceeded/i.test(markers),
  }
}

/** One answer as design §14's code, without Google's text. */
function failure(check: { account: string; backend: "colab" | "enterprise"; check: string }, answer: Answer, api: string, notFound?: string): DoctorCheck {
  if (answer.status === 401) return { ...check, status: "AUTH_REQUIRED", detail: "Google rejected the sign-in.", next: `Sign in again with /connect for ${check.account}.` }
  if (answer.status === 403) {
    if (answer.disabled) return { ...check, status: "API_DISABLED", detail: "the API is not enabled for this account's Google Cloud project.", enableUrl: enableUrl(api) }
    if (check.backend === "colab") return { ...check, status: "COLAB_API_UNAVAILABLE", detail: "Google refused the Colab API for this OAuth client or its project.", next: "Notebook editing still works; runs need an enterprise account, or the operator enables colaboratory.googleapis.com for the client's project." }
    return { ...check, status: "PERMISSION_DENIED", detail: "IAM refused the call for this account.", next: `Ask an admin for the role docs/auth.md names for ${check.account}.` }
  }
  if (answer.quota) return { ...check, status: "UNAVAILABLE", detail: "Google's quota refused the call after retries.", next: "Try again shortly." }
  if (answer.status === 404) return { ...check, status: "ERROR", detail: notFound ?? "Google answered not found.", next: "Check the account's project, region and bucket." }
  if (answer.status >= 500) return { ...check, status: "UNAVAILABLE", detail: "Google answered a server error.", next: "Try again shortly." }
  return { ...check, status: "ERROR", detail: `Google answered HTTP ${answer.status}.`, next: "Try again; if it persists, check the account's Google Cloud setup." }
}

/** The plugin's own account checks that fail before any Google call, as a check's result. */
function accountFailure(account: ResolvedAccount, check: string, error: unknown): DoctorCheck {
  const base = { account: account.alias, backend: account.backend, check }
  if (ColabError.is(error)) return { ...base, status: error.code, detail: error.detail, next: error.next }
  return { ...base, status: "ERROR", detail: `the check failed (${redact(error instanceof Error ? error.message : "no reason given")}).`, next: "Try again." }
}

export class Doctor {
  constructor(private readonly environment: DoctorEnvironment) {}

  private get fetchImpl(): typeof globalThis.fetch {
    return this.environment.fetch ?? globalThis.fetch
  }

  private async assert(sessionID: string, action: string, resources: readonly string[], metadata: Readonly<Record<string, unknown>>): Promise<boolean> {
    if (!this.environment.assert) return true
    try {
      await this.environment.assert({ sessionID, action, resources, metadata })
      return true
    } catch {
      return false
    }
  }

  private async readCheck(account: ResolvedAccount, sessionID: string, check: string, operation: Operation, url: string, api: string, notFound?: string): Promise<DoctorCheck> {
    const base = { account: account.alias, backend: account.backend, check }
    if (!(await this.assert(sessionID, READ_ACTION, [operationResource(account.alias, operation)], { account: account.alias, operation }))) {
      return { ...base, status: "DENIED", detail: "a permission rule or reply refused colab.read, so the check did not run." }
    }
    const scopes = account.backend === "colab" ? [SCOPES.colaboratoryReadonly] : [SCOPES.cloudPlatform]
    let token: string
    try {
      token = await this.environment.auth.token(account.alias, scopes, this.environment.signal ?? new AbortController().signal)
    } catch (error) {
      return accountFailure(account, check, error)
    }
    let answer: Answer
    try {
      answer = await get(url, token, this.fetchImpl, this.environment.signal)
    } catch (error) {
      return accountFailure(account, check, error)
    }
    if (answer.ok) return { ...base, status: "OK" }
    return failure(base, answer, api, notFound)
  }

  /** The runtime print: skipped at read-only, without a wired probe, or when the account has no runtime of ours. */
  private async runtimeCheck(account: ResolvedAccount, sessionID: string): Promise<DoctorCheck> {
    const base = { account: account.alias, backend: account.backend, check: "runtime print(1)" }
    if (account.backend !== "colab") return { ...base, status: "SKIPPED", detail: "Enterprise accounts run whole notebooks as jobs; there is no interactive runtime to print on." }
    if (this.environment.options.access === "read-only") return { ...base, status: "SKIPPED", detail: "read-only access skips running code." }
    const probe = this.environment.runtimeProbe
    if (!probe) return { ...base, status: "SKIPPED", detail: "the plugin's runtime ports are not wired into sign-in in this version, so no runtime was run on." }
    let runtimes: readonly string[]
    try {
      runtimes = await probe.runtimes(account.alias)
    } catch (error) {
      return accountFailure(account, base.check, error)
    }
    if (runtimes.length === 0) return { ...base, status: "SKIPPED", detail: `no runtime of the plugin's own is running for ${account.alias}.` }
    const runtime = runtimes[0]!
    if (!(await this.assert(sessionID, "colab.run", runResources(account.alias, runtime), { account: account.alias, runtime, check: "doctor" }))) {
      return { ...base, status: "DENIED", detail: "a permission rule or reply refused colab.run, so no code ran." }
    }
    try {
      await probe.print(account.alias, runtime, this.environment.signal ?? new AbortController().signal)
      return { ...base, status: "OK" }
    } catch (error) {
      if (ColabError.is(error)) return { ...base, status: error.code, detail: error.detail, next: error.next }
      return { ...base, status: "ERROR", detail: "the print did not complete.", next: "Try again; if it persists, plan a fresh runtime." }
    }
  }

  /** Every check, in account order: the provider reads, then the runtime print. */
  async checks(sessionID: string): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = []
    for (const account of this.environment.options.accounts) {
      if (account.backend === "colab") {
        checks.push(await this.readCheck(account, sessionID, "runtimespecs.list", OPERATIONS.runtimeSpecsList, SPECS_URL, "colaboratory.googleapis.com"))
      } else {
        if (!account.project || !account.region) {
          checks.push({ account: account.alias, backend: account.backend, check: "notebookRuntimeTemplates.list", status: "PROJECT_REQUIRED", detail: `the enterprise account ${account.alias} has no project or region.`, next: `Set accounts.${account.alias}.project and accounts.${account.alias}.region.` })
        } else {
          checks.push(await this.readCheck(account, sessionID, "notebookRuntimeTemplates.list", OPERATIONS.templatesList, templatesUrl(account), "aiplatform.googleapis.com"))
        }
        const bucket = account.outputBucket
        if (!bucket) {
          checks.push({ account: account.alias, backend: account.backend, check: "storage.objects.list", status: "SKIPPED", detail: `the account has no outputBucket to list.`, next: `Set accounts.${account.alias}.outputBucket.` })
        } else {
          const url = bucketUrl(bucket)
          if (!url) checks.push({ account: account.alias, backend: account.backend, check: "storage.objects.list", status: "ERROR", detail: "the outputBucket is not a gs:// URI.", next: `Fix accounts.${account.alias}.outputBucket.` })
          else checks.push(await this.readCheck(account, sessionID, "storage.objects.list", OPERATIONS.storageObjectsList, url, "storage.googleapis.com", "the bucket was not found."))
        }
      }
      checks.push(await this.runtimeCheck(account, sessionID))
      const granted = await this.environment.auth.scopes(account.alias).catch(() => [])
      if (widerThanAccess(account, granted)) {
        checks.push({ account: account.alias, backend: account.backend, check: "access", status: "SKIPPED", detail: "the sign-in holds cloud-platform, which reaches more than this account's read access (SCOPE_WIDER_THAN_ACCESS)." })
      }
    }
    return checks
  }

  /** The synthetic message `/colab-doctor` posts: one line per check and a summary. */
  async run(input: { readonly sessionID: string }): Promise<{ readonly text: string; readonly description: string }> {
    const checks = await this.checks(input.sessionID)
    return { text: formatDoctor(checks), description: summarizeDoctor(checks) }
  }
}

export function formatDoctor(checks: readonly DoctorCheck[]): string {
  const lines = ["Colab doctor", ""]
  if (checks.length === 0) lines.push("No accounts are configured.")
  for (const check of checks) {
    const parts = [
      check.detail ? check.detail.replace(/[.\s]+$/, "") : undefined,
      check.enableUrl ? `Enable it at ${check.enableUrl}` : undefined,
      check.next ? `Next step: ${check.next.replace(/[.\s]+$/, "")}` : undefined,
    ].filter((part): part is string => part !== undefined)
    lines.push(`- ${check.account} (${check.backend}) ${check.check}: ${check.status}${parts.length > 0 ? ` · ${parts.join(". ")}.` : ""}`)
  }
  lines.push("", summarizeDoctor(checks))
  return lines.join("\n")
}

export function summarizeDoctor(checks: readonly DoctorCheck[]): string {
  const ok = checks.filter((check) => check.status === "OK").length
  const attention = checks.filter((check) => check.status !== "OK" && check.status !== "SKIPPED").length
  if (checks.length === 0) return "Colab doctor: no accounts."
  return `Colab doctor: ${ok} OK${attention > 0 ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""}`
}
