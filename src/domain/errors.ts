/**
 * Every code the plugin raises, in one table: the state a tool result carries, what the code means, and the default
 * next step. A message reads `CODE: What happened. Next step: What to do.` A raise site may give a more
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
  RULES_NOT_ADDED: entry("failed", "The plugin's default permission rules could not be added, so Colab tools may run without asking.", "Restart OpenCode."),
  STATUS_UNAVAILABLE: entry("failed", "Colab status is unavailable right now.", "Try again in a few seconds; if it persists, restart OpenCode."),
} as const satisfies Record<string, ErrorEntry>

export type ErrorCode = keyof typeof ERRORS
export const ERROR_CODES = Object.keys(ERRORS) as ErrorCode[]

/** Warnings ride on a result's `warnings`; none stops a call. */
export const WARNINGS = {
} as const

export type WarningCode = keyof typeof WARNINGS
export const WARNING_CODES = Object.keys(WARNINGS) as WarningCode[]

/** A plugin code as the source contract's code, for the plugin's sources. */
export const SOURCE_CODES: Partial<Record<ErrorCode, string>> = {}

/** The one message shape: `CODE: What happened. Next step: What to do.` Both parts are sentences. */
export const errorText = (code: ErrorCode, message: string, next: string): string => `${code}: ${sentence(message)} Next step: ${sentence(next)}`

const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)

export interface ErrorExtras {
  /** A more specific next step than the table's. */
  readonly next?: string
  /** Why, when a code has more than one cause. */
  readonly reason?: string
  /** When a quota answer says when to retry. */
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
