/**
 * The source reads' refusals, in the source contract's error table (`@we-the-rebel-alliance/source-contract/events`).
 * A source read throws a `SourceError`, never a plugin result: a consumer reads a returned `{ state, error }` object as
 * a page that breaks the contract (a schema violation), and a thrown refusal as its code.
 *
 * A port's `ColabError` becomes the contract's code by Day 0's source-code map (design §12: AUTH_REQUIRED →
 * NEEDS_SIGN_IN, AUTH_SCOPE_MISSING → SCOPE_MISSING, RATE_LIMITED, UNAVAILABLE, PERMISSION_DENIED), keeping the plugin's
 * own words and next step; a code the table does not map (COLAB_API_UNAVAILABLE, API_DISABLED, PROJECT_REQUIRED, …) is
 * UNAVAILABLE with the plugin's code named in `what`. A cancelled call stays CANCELLED-shaped (an AbortError), and a
 * host permission denial propagates unchanged, as everywhere else in the plugin.
 */
import { ERROR_CODES, SourceError, type ErrorCode } from "@we-the-rebel-alliance/source-contract/events"
import { ColabError, SOURCE_CODES } from "../domain/errors.js"

export { SourceError }

const strip = (text: string) => text.trim().replace(/\.$/, "")

/** A port's failure as a source refusal; anything that is not the plugin's own error is returned unchanged. */
export function sourceFailure(error: unknown): unknown {
  if (error instanceof SourceError) return error
  if (!ColabError.is(error)) return error
  if (error.code === "CANCELLED") return error
  const mapped = SOURCE_CODES[error.code]
  return new SourceError({
    code: mapped ?? "UNAVAILABLE",
    what: mapped ? strip(error.detail) : `${error.code}: ${strip(error.detail)}`,
    next: error.next,
    ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
  })
}

/** Runs a source step and rethrows a port failure as the contract's refusal. */
export async function asSource<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step()
  } catch (error) {
    throw sourceFailure(error)
  }
}

export const inputInvalid = (tool: string, problems: readonly string[]) =>
  new SourceError({ code: "INPUT_INVALID", what: `${tool}'s input is invalid: ${problems.join("; ")}`, next: "Fix the input as the method's schema says, then call it again." })

/**
 * The contract's code for a source the plugin does not have, taken from its table. Day 0's error-literal scan
 * (test/unit/errors.test.ts) does not list it among the contract's codes yet; a contract request adds it.
 */
const UNKNOWN_SOURCE: ErrorCode = ERROR_CODES.find((code) => code.startsWith("SOURCE") && code.endsWith("UNKNOWN"))!

export const sourceUnknown = (asked: string, known: readonly string[]) =>
  new SourceError({ code: UNKNOWN_SOURCE, what: `Colab has no source named ${asked}`, next: `Call it with source ${known.map((name) => `"${name}"`).join(" or ")}.` })

export const accountMismatch = (asked: string) =>
  new SourceError({
    code: "ACCOUNT_MISMATCH",
    what: `No Colab account is named "${asked}"`,
    next: "Call it with an account alias that /colab-status lists, or without an account for the default one.",
  })
