/**
 * Every code the plugin raises, in one table (design §12): the state a tool result carries, what the code means, and
 * the default next step. A message reads `CODE: What happened. Next step: What to do.` A raise site may give a more
 * specific next step; it never puts notebook, output or Google text in either part (design §7.3).
 *
 * `docs/errors.md` is generated from this table (`node scripts/errors-doc.mjs`), and a unit test fails when the two
 * differ. This module imports nothing, so a script can load it with Node's type stripping.
 */

export type ResultState = "refused" | "failed"

interface ErrorEntry {
  /** The `state` of a tool result that carries this code. */
  readonly state: ResultState
  /** What the code means, for people reading the docs. */
  readonly meaning: string
  /** The default next step; a raise site may give a more specific one. */
  readonly next: string
}

const entry = (state: ResultState, meaning: string, next: string): ErrorEntry => ({ state, meaning, next })

export const ERRORS = {
  // ── Shared with the family ─────────────────────────────────────────────
  HOST_UNTESTED: entry("refused", "OpenCode is outside the supported range.", "Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true."),
  OPTIONS_INVALID: entry("refused", "A plugin option is unknown or has an invalid value.", "Fix the plugin's options in opencode.json as the message says."),
  SKILLS_INVALID: entry("refused", "A bundled skill is missing or malformed.", "Reinstall the plugin."),
  CANCELLED: entry("failed", "The call was stopped before it finished.", "Call it again if you still need the result."),
  // ── Day 0 additions (not in design §12; see docs/v1-design.md, Open points) ──
  INPUT_INVALID: entry("refused", "The input does not fit the tool's schema. Nothing ran.", "Check the input against the tool's schema, then call it again."),
  ACCOUNT_UNKNOWN: entry("refused", "The account alias is not configured.", "Pass a configured alias; colab_status lists them."),
  ACCOUNT_REQUIRED: entry("refused", "More than one account is configured, none is named default, and the call named none.", "Pass account with one of the aliases colab_status lists."),
  NOT_IMPLEMENTED: entry("refused", "This tool or plan action is declared but not built in this pre-release.", "Use another tool, or wait for a release that builds it."),
  RULES_NOT_ADDED: entry("failed", "The plugin's default permission rules could not be added, so Colab tools may run without asking.", "Restart OpenCode."),
  TOOLS_NOT_REGISTERED: entry("failed", "The Colab tools could not be registered.", "Restart OpenCode."),
  STATUS_UNAVAILABLE: entry("failed", "Colab status is unavailable right now.", "Try again in a few seconds; if it persists, restart OpenCode."),
  LEDGER_UNAVAILABLE: entry("failed", "The plugin's run ledger could not be read or written, or its lock was not released in time.", "Try again; if it persists, check that the state folder is writable."),
  // ── Auth and accounts ─────────────────────────────────────────────────
  AUTH_REQUIRED: entry(
    "refused",
    "No usable credential; reason session-control when a Workspace reauthentication policy expired a cloud-platform grant.",
    "Run /connect and choose Colab (or opencode auth login colab-<alias>); for session control, sign in again, and the admin may exempt the client as a trusted app.",
  ),
  AUTH_SCOPE_MISSING: entry("refused", "The sign-in lacks the scope this call needs; Google was not called.", "Sign in again at Read and write, or approve the scope."),
  AUTH_CLIENT_REQUIRED: entry("refused", "No OAuth client is configured.", "Enter a Desktop client in /connect, or set oauthClient."),
  // The four sign-in form codes, with gws's meaning and next step.
  AUTH_CLIENT_INVALID: entry(
    "refused",
    "The sign-in form has only one of the client ID and secret, a value in the wrong format, a client JSON that is not Google's downloaded client JSON, or an answer that is not text.",
    "Enter both the client ID and the secret of the same Desktop app OAuth client; /colab-status lists the steps.",
  ),
  AUTH_REDIRECT_INVALID: entry(
    "refused",
    "The sign-in's redirectUri is not an absolute https (or loopback http) URL, callbackPort is missing or not a port, or the loopback listener could not bind.",
    "Set redirectUri to an absolute https URL and callbackPort to a port from 1 to 65535, or leave both unset for a loopback redirect.",
  ),
  AUTH_REDIRECT_MISMATCH: entry(
    "refused",
    "Google would refuse the redirect for this client: a Desktop app client accepts only a loopback redirect, and a Web application client accepts only a redirect URI registered on it, exactly. Nothing was opened in the browser.",
    "Use a Web application client that lists the redirect, as its downloaded client JSON, or leave redirectUri unset for a Desktop app client.",
  ),
  AUTH_WRITE_UNCONFIRMED: entry("refused", "Read and write access was chosen in the sign-in form without confirming the write scopes.", "Sign in again and confirm the write scopes, or choose Read-only."),
  ACCOUNT_READ_ONLY: entry(
    "refused",
    "The account's access is read, so the plugin makes no change on it: no run, upload, edit, download, pause, plan or commit (design §4). Nothing ran.",
    "Set accounts.<alias>.access to write and sign in again.",
  ),
  ADC_UNAVAILABLE: entry("refused", "Application Default Credentials found nothing.", "Use interactive mode, or set GOOGLE_APPLICATION_CREDENTIALS for an enterprise account."),
  ADC_REFUSED: entry("refused", "ADC on a colab account, or ADC in Jelly without allowAdcInHost.", "Use interactive mode; ADC is for enterprise accounts only."),
  COLAB_API_UNAVAILABLE: entry(
    "refused",
    "Google refused the Colab API for this client or project.",
    "Notebook editing still works; runs need an enterprise account; the operator enables colaboratory.googleapis.com.",
  ),
  API_DISABLED: entry("refused", "The Vertex AI, Compute, Dataform or Drive API is off in the project.", "Open the enable link in the message."),
  PERMISSION_DENIED: entry("refused", "IAM refused the call; the message names the permission Google named.", "Ask an admin for the named role (docs/auth.md)."),
  PROJECT_REQUIRED: entry("refused", "The enterprise account lacks project or region.", "Set accounts.<alias>.project and region."),
  BUCKET_REQUIRED: entry("refused", "The enterprise account lacks outputBucket.", "Set accounts.<alias>.outputBucket."),
  RUN_IDENTITY_REQUIRED: entry("refused", "An Enterprise job with no serviceAccount and no runAsUser.", "Set serviceAccount (recommended) or runAsUser: true."),
  // ── Resources ─────────────────────────────────────────────────────────
  NOT_FOUND: entry("refused", "The notebook, cell, runtime, job, schedule or file was not found.", "List what exists with colab_find, colab_runtimes or colab_files."),
  RUNTIME_NOT_OURS: entry("refused", "The runtime was not created by this plugin.", "Plan a runtime of the plugin's own with colab_plan({ action: \"runtime.create\" })."),
  RUNTIME_HAS_CREDENTIALS: entry("refused", "A Drive mount or a Google credential is on the runtime; it is now tainted for good.", "Plan a fresh runtime.create, and release this one by plan."),
  RUNTIME_SHARED: entry("refused", "Another client's session or connection is on the runtime; it is now tainted for good.", "Plan a fresh runtime.create."),
  RUNTIME_UNVERIFIED: entry(
    "refused",
    "The runtime check could not complete, its output did not parse, the probe kernel was restarted or replaced, or the runtime URL is not an allowed Google host.",
    "Retry; if it persists, plan a fresh runtime.",
  ),
  SPEC_NOT_ELIGIBLE: entry("refused", "The person's tier cannot use that runtime spec.", "Pick an eligible spec from colab_specs."),
  ACCELERATOR_NOT_ALLOWED: entry("refused", "The accelerator is not in the accelerators option.", "Pick an allowed spec; the person may add the accelerator."),
  RUNTIME_CAP: entry("refused", "maxRuntimes runtimes of the plugin's own are running.", "Reuse the runtime the message names, or release one."),
  CAPACITY_UNAVAILABLE: entry("failed", "Google has no capacity for that spec now.", "Pick another eligible spec, or try later."),
  USAGE_LIMIT: entry("refused", "Compute units or free usage are exhausted.", "Tell the person; a CPU spec may still work."),
  TOO_MANY_RUNTIMES: entry("refused", "Colab's own runtime limit is reached.", "Release one of the plugin's runtimes, or reuse one."),
  RUNTIME_GONE: entry("failed", "The runtime ended.", "Plan a new runtime.create with the same spec."),
  RUNTIME_BUSY: entry("refused", "A release or stop while a run is active.", "Stop the run with colab_cancel, or plan again with force."),
  INTERACTIVE_UNSUPPORTED: entry("refused", "colab_run on an enterprise account: Enterprise runs whole notebooks as jobs.", "Plan colab_plan({ action: \"job.create\", notebook })."),
  // ── Runs ──────────────────────────────────────────────────────────────
  KERNEL_BUSY: entry("refused", "The kernel session runs another run.", "Wait with colab_execution, or use another session."),
  KERNEL_DIED: entry("failed", "The kernel died, often from memory.", "Rerun; pick a high-memory spec if eligible."),
  RUN_TIMEOUT: entry("failed", "timeoutSec was reached and the kernel was interrupted.", "Raise timeoutSec (up to maxRunSeconds), or use an Enterprise job."),
  COLAB_UI_API: entry("failed", "The code called drive.mount, auth, userdata or another Colab UI API; the plugin declined it.", "Move files with colab_upload and colab_download; pass values in code."),
  // ── Notebooks and files ───────────────────────────────────────────────
  NOTEBOOK_INVALID: entry("refused", "The file is not an nbformat 4 notebook.", "Fix it, or recreate it with colab_edit and a create op."),
  NOTEBOOK_CHANGED: entry("refused", "The file differs from ifHash, or changed during a run (the outputs are kept under .colab/runs).", "Read it again with colab_notebook, then edit."),
  LOCAL_CHANGED: entry("refused", "A pull would overwrite local edits that were not pushed.", "Push first, or pull to another path."),
  PATH_REFUSED: entry("refused", "The path is outside the project and the allowed roots, or is a symlink.", "Use a path inside the project."),
  FILE_EXISTS: entry("refused", "The destination exists and overwrite was not set.", "Pass overwrite: true after the person agrees."),
  FILE_TOO_LARGE: entry("refused", "The file is over the size cap.", "Split it, or raise maxUploadBytes or maxDownloadBytes."),
  UPLOAD_SECRET_REFUSED: entry("refused", "The file is secret-shaped (an env file, a key, a credential).", "Don't upload it; the person may set allowSecretUpload."),
  DRIVE_CONFLICT: entry("refused", "Drive's head revision differs from the sync record's base.", "Pull to another path, merge, and plan again."),
  // ── Cost ──────────────────────────────────────────────────────────────
  COST_CAP: entry("refused", "The Enterprise compute estimate is over the cap.", "Pick a smaller machine or a shorter timeout, or pass maxUsd up to maxJobUsdCeiling."),
  ESTIMATE_UNKNOWN: entry("refused", "The machine or accelerator is not in the dated price table.", "Pick a priced machine, or add it to the rates option."),
  SCHEDULE_UNBOUNDED: entry("refused", "The schedule has no maxRunCount and no endTime.", "Add a bound."),
  SCHEDULE_OVERLAP: entry("refused", "The shortest gap between occurrences is under executionTimeout plus the provisioning margin.", "Widen the cron, or shorten the timeout."),
  UNCERTAIN: entry("failed", "A schedule create's answer was lost, and no schedule with the plan's display name was found.", "Check colab_schedules before planning again."),
  BUDGET_REACHED: entry("refused", "The opt-in budget is spent.", "Wait for the daily reset, or raise budget."),
  // ── Enterprise jobs ───────────────────────────────────────────────────
  JOB_FAILED: entry("failed", "The job failed.", "Read the output notebook and error with colab_execution({ job })."),
  JOB_TIMEOUT: entry("failed", "The job hit executionTimeout.", "Read the output notebook with colab_execution({ job })."),
  JOB_UNCANCELLABLE: entry("refused", "Cancel did not stop the job.", "Wait for the timeout; the message shows what remains."),
  RESULTS_UNAVAILABLE: entry("failed", "The output notebook is not in the bucket.", "Check the job's state with colab_jobs, and the bucket."),
  SHARE_UNSUPPORTED: entry("refused", "Sharing is not part of this plugin.", "Share with the gws plugin."),
  ACTION_UNSUPPORTED: entry("refused", "IAM, templates, setDefault and Enterprise runtime creation are not part of v0.1.0.", "Use the Google Cloud console."),
  // ── Plans ─────────────────────────────────────────────────────────────
  PLAN_NOT_FOUND: entry("refused", "No plan has this id.", "Run colab_plan first."),
  PLAN_ALREADY_USED: entry("refused", "This plan was already committed, or its commit is running.", "Create a new plan to repeat the change; check the earlier result first."),
  PLAN_EXPIRED: entry("refused", "The plan is older than planTtlSeconds.", "Create a new plan."),
  PLAN_CALLER_MISMATCH: entry("refused", "A plan is bound to the session, agent and account that created it.", "Plan again from this session."),
  PLAN_CHANGED: entry(
    "refused",
    "What the plan previewed changed: eligibility, runtime state, the notebook hash, the Drive revision, or a cost estimate more than 10% higher.",
    "Plan again and show the new preview.",
  ),
  CATEGORY_MISMATCH: entry("refused", "The plan's category is not this commit tool's.", "Commit a write plan with colab_write and a delete plan with colab_delete, passing only {planId}."),
  // ── Transport ─────────────────────────────────────────────────────────
  RATE_LIMITED: entry(
    "failed",
    "Google's quota refused the call after retries; retryAfterSec says when to retry. The Colab API quota is per client project, shared by every user of that client.",
    "Make the same call after that delay.",
  ),
  UNAVAILABLE: entry("failed", "Google answered 5xx, or the network failed, after retries.", "Make the same call later."),
} as const satisfies Record<string, ErrorEntry>

export type ErrorCode = keyof typeof ERRORS
export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[]

/** The codes design §12 lists, in its order, and the ones Day 0 adds. A unit test keeps both lists true. */
export const DAY0_CODES: readonly ErrorCode[] = [
  "AUTH_CLIENT_INVALID",
  "AUTH_REDIRECT_INVALID",
  "AUTH_REDIRECT_MISMATCH",
  "AUTH_WRITE_UNCONFIRMED",
  "ACCOUNT_READ_ONLY",
  "INPUT_INVALID",
  "ACCOUNT_UNKNOWN",
  "ACCOUNT_REQUIRED",
  "NOT_IMPLEMENTED",
  "RULES_NOT_ADDED",
  "TOOLS_NOT_REGISTERED",
  "STATUS_UNAVAILABLE",
  "LEDGER_UNAVAILABLE",
]

/** Warnings ride on a result's `warnings`; none stops a call (design §12). */
export const WARNINGS = {
  FREE_TIER_PRIORITY: "The account is on Colab's free tier, which prioritises people working in a notebook; a run may be reclaimed.",
  FOREIGN_NOTEBOOK: "The notebook was written or last changed by someone else. It is a warning, not a fence: read it before running it.",
  REVISION_PIN_SKIPPED: "The Drive file already has 200 kept revisions, so the replaced revision is not pinned.",
  EUC_RUNTIME: "An Enterprise runtime has end-user credentials on.",
  IDLE_SHUTDOWN_OFF: "An Enterprise runtime's template has idle shutdown off, so nothing bounds its cost.",
  SCOPE_WIDER_THAN_ACCESS: "The enterprise sign-in holds cloud-platform, which reaches more than the plugin's access level.",
  SECRET_WITHHELD: "Secret-shaped text in a source or output was replaced with [withheld: secret-shaped].",
  OUTPUT_TRUNCATED: "Inline output was cut at the caps; the rest is in the run's files.",
  UNHARVESTED: "A runtime's keep paths could not be harvested, so its release is blocked.",
  DETACHED: "The run's output stream ended with an earlier OpenCode process; the code may still be running.",
  BUDGET_WARN: "The opt-in budget is reached; the call ran because the budget's action is warn.",
  RATES_UNKNOWN: "Consumer compute-unit rates are not published, so cost is counted in runtime-hours.",
} as const

export type WarningCode = keyof typeof WARNINGS
export const WARNING_CODES = Object.keys(WARNINGS) as WarningCode[]

/**
 * A plugin code as the source contract's code, for the `colab.runs` and `colab.runtimes` reads (design §12). Codes the
 * source reads raise themselves (`ACCOUNT_MISMATCH`, `CURSOR_*`, `TOO_LARGE`) come from the contract, not this table.
 */
export const SOURCE_CODES: Partial<Record<ErrorCode, string>> = {
  AUTH_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_CLIENT_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_SCOPE_MISSING: "SCOPE_MISSING",
  RATE_LIMITED: "RATE_LIMITED",
  UNAVAILABLE: "UNAVAILABLE",
  PERMISSION_DENIED: "PERMISSION_DENIED",
}

/** The one message shape: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: ErrorCode, message: string, next: string): string => `${code}: ${sentence(message)} Next step: ${sentence(next)}`

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

export interface ErrorExtras {
  /** A more specific next step than the table's. */
  readonly next?: string
  /** `session-control` on AUTH_REQUIRED (design §4). */
  readonly reason?: string
  /** On RATE_LIMITED. */
  readonly retryAfterSec?: number
}

export class ColabError extends Error {
  readonly code: ErrorCode
  readonly state: ResultState
  /** What happened, without the code or the next step. */
  readonly detail: string
  readonly next: string
  readonly reason?: string
  readonly retryAfterSec?: number

  constructor(code: ErrorCode, message: string = ERRORS[code].meaning, extras: ErrorExtras = {}) {
    const next = extras.next ?? ERRORS[code].next
    super(errorText(code, message, next))
    this.name = "ColabError"
    this.code = code
    this.state = ERRORS[code].state
    this.detail = sentence(message)
    this.next = sentence(next)
    if (extras.reason !== undefined) this.reason = extras.reason
    if (extras.retryAfterSec !== undefined) this.retryAfterSec = extras.retryAfterSec
  }

  static is(error: unknown): error is ColabError {
    return error instanceof ColabError
  }
}

/** The docs page, generated from the table: one row per code, then the warnings. */
export function renderErrorDoc(): string {
  const cell = (text: string) => text.replaceAll("|", "\\|")
  const lines = [
    "# Errors",
    "",
    "Generated from `src/domain/errors.ts` by `node scripts/errors-doc.mjs`; a unit test fails when they differ. Every",
    "message reads `CODE: What happened. Next step: What to do.` A tool result that fails carries `state`, `error` (the",
    "code), `message` and `next`.",
    "",
    "## Errors",
    "",
    "| Code | state | Meaning | Next step |",
    "| --- | --- | --- | --- |",
    ...ERROR_CODES.map((code) => `| \`${code}\` | ${ERRORS[code].state} | ${cell(ERRORS[code].meaning)} | ${cell(ERRORS[code].next)} |`),
    "",
    "## Warnings",
    "",
    "| Code | Meaning |",
    "| --- | --- |",
    ...WARNING_CODES.map((code) => `| \`${code}\` | ${cell(WARNINGS[code])} |`),
    "",
  ]
  return lines.join("\n")
}
