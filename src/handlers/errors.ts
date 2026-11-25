/**
 * One place where the plugin's own error table becomes the contract's: every handler failure reads
 * `CODE: What happened. Next step: What to do.`, with a code from contract §12. The old code's meaning stays in the
 * sentence (and in `usage`), never in a plugin-specific code the register would turn into UNAVAILABLE.
 */
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { ColabError, type ErrorCode as ColabCode } from "../domain/errors.js"
import { redact } from "../redact.js"

type ContractCode =
  | "NEEDS_SIGN_IN"
  | "SCOPE_MISSING"
  | "ACCOUNT_REQUIRED"
  | "ACCOUNT_UNKNOWN"
  | "CURSOR_INVALID"
  | "RATE_LIMITED"
  | "BUDGET_EXCEEDED"
  | "TOO_LARGE"
  | "INPUT_INVALID"
  | "SOURCE_UNKNOWN"
  | "PERMISSION_DENIED"
  | "PLAN_INVALID"
  | "PLAN_USED"
  | "HOST_UNTESTED"
  | "OPTIONS_INVALID"
  | "UNAVAILABLE"

const CODES: Readonly<Record<string, ContractCode>> = {
  HOST_UNTESTED: "HOST_UNTESTED",
  OPTIONS_INVALID: "OPTIONS_INVALID",
  INPUT_INVALID: "INPUT_INVALID",
  ACCOUNT_UNKNOWN: "ACCOUNT_UNKNOWN",
  ACCOUNT_REQUIRED: "ACCOUNT_REQUIRED",
  PERMISSION_DENIED: "PERMISSION_DENIED",
  AUTH_REQUIRED: "NEEDS_SIGN_IN",
  AUTH_CLIENT_REQUIRED: "NEEDS_SIGN_IN",
  ADC_UNAVAILABLE: "NEEDS_SIGN_IN",
  ADC_REFUSED: "NEEDS_SIGN_IN",
  AUTH_SCOPE_MISSING: "SCOPE_MISSING",
  RATE_LIMITED: "RATE_LIMITED",
  BUDGET_REACHED: "BUDGET_EXCEEDED",
  COST_CAP: "BUDGET_EXCEEDED",
  FILE_TOO_LARGE: "TOO_LARGE",
  PLAN_CALLER_MISMATCH: "PLAN_INVALID",
  PLAN_CHANGED: "PLAN_INVALID",
  UPLOAD_SECRET_REFUSED: "PERMISSION_DENIED",
  NOT_FOUND: "INPUT_INVALID",
  NOTEBOOK_INVALID: "INPUT_INVALID",
  NOTEBOOK_CHANGED: "INPUT_INVALID",
  LOCAL_CHANGED: "INPUT_INVALID",
  PATH_REFUSED: "INPUT_INVALID",
  FILE_EXISTS: "INPUT_INVALID",
  DRIVE_CONFLICT: "INPUT_INVALID",
  SPEC_NOT_ELIGIBLE: "INPUT_INVALID",
  ACCELERATOR_NOT_ALLOWED: "INPUT_INVALID",
  RUNTIME_CAP: "INPUT_INVALID",
  RUNTIME_NOT_OURS: "INPUT_INVALID",
  RUNTIME_HAS_CREDENTIALS: "INPUT_INVALID",
  RUNTIME_SHARED: "INPUT_INVALID",
  RUNTIME_UNVERIFIED: "INPUT_INVALID",
  RUNTIME_BUSY: "INPUT_INVALID",
  TOO_MANY_RUNTIMES: "INPUT_INVALID",
  USAGE_LIMIT: "INPUT_INVALID",
  KERNEL_BUSY: "INPUT_INVALID",
  INTERACTIVE_UNSUPPORTED: "INPUT_INVALID",
  COLAB_UI_API: "INPUT_INVALID",
  ACTION_UNSUPPORTED: "INPUT_INVALID",
  SHARE_UNSUPPORTED: "INPUT_INVALID",
  SCHEDULE_UNBOUNDED: "INPUT_INVALID",
  SCHEDULE_OVERLAP: "INPUT_INVALID",
  ESTIMATE_UNKNOWN: "INPUT_INVALID",
  PROJECT_REQUIRED: "OPTIONS_INVALID",
  BUCKET_REQUIRED: "OPTIONS_INVALID",
  RUN_IDENTITY_REQUIRED: "OPTIONS_INVALID",
  AUTH_CLIENT_INVALID: "OPTIONS_INVALID",
  AUTH_REDIRECT_INVALID: "OPTIONS_INVALID",
  AUTH_REDIRECT_MISMATCH: "OPTIONS_INVALID",
  AUTH_WRITE_UNCONFIRMED: "OPTIONS_INVALID",
  COLAB_API_UNAVAILABLE: "UNAVAILABLE",
  API_DISABLED: "UNAVAILABLE",
  CAPACITY_UNAVAILABLE: "UNAVAILABLE",
  RUNTIME_GONE: "UNAVAILABLE",
  KERNEL_DIED: "UNAVAILABLE",
  RUN_TIMEOUT: "UNAVAILABLE",
  JOB_FAILED: "UNAVAILABLE",
  JOB_TIMEOUT: "UNAVAILABLE",
  JOB_UNCANCELLABLE: "UNAVAILABLE",
  RESULTS_UNAVAILABLE: "UNAVAILABLE",
  UNCERTAIN: "UNAVAILABLE",
  CANCELLED: "UNAVAILABLE",
  LEDGER_UNAVAILABLE: "UNAVAILABLE",
  STATUS_UNAVAILABLE: "UNAVAILABLE",
  UNAVAILABLE: "UNAVAILABLE",
}

const oneLine = (text: string) => redact(text).replace(/\s+/g, " ").trim().slice(0, 400)

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** A handler's failure as the contract's refusal; a `RegisterError` passes through untouched. */
export function asRefusal(error: unknown): RegisterError {
  if (error instanceof RegisterError) return error
  if (error instanceof Error && error.name === "AbortError") {
    return new RegisterError(refusal("UNAVAILABLE", "The call was cancelled before it finished", "Call it again if you still need the result."))
  }
  if (ColabError.is(error)) {
    const code = CODES[error.code as ColabCode] ?? "UNAVAILABLE"
    return new RegisterError(refusal(code, oneLine(error.detail), oneLine(error.next)))
  }
  return new RegisterError(refusal("UNAVAILABLE", `The call failed: ${oneLine(reason(error))}`, "Try again; if it keeps failing, check the plugin's status."))
}

/** Run a handler's work, mapping its failure once. */
export async function mapped<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw asRefusal(error)
  }
}
