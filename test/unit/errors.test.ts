// The one error table: design §12's codes, the Day 0 additions, the message shape, the generated docs, and every code
// raised in src/ being in the table.
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ColabError, DAY0_CODES, ERROR_CODES, renderErrorDoc, SOURCE_CODES, WARNING_CODES } from "../../src/domain/errors.js"

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const read = (file: string) => readFileSync(join(ROOT, file), "utf8")

/** Design §12's codes, in its order, as one row each (rows naming several are split). */
const DESIGN_CODES = [
  "HOST_UNTESTED", "OPTIONS_INVALID", "SKILLS_INVALID", "CANCELLED",
  "AUTH_REQUIRED", "AUTH_SCOPE_MISSING", "AUTH_CLIENT_REQUIRED", "ADC_UNAVAILABLE", "ADC_REFUSED", "COLAB_API_UNAVAILABLE", "API_DISABLED", "PERMISSION_DENIED",
  "PROJECT_REQUIRED", "BUCKET_REQUIRED", "RUN_IDENTITY_REQUIRED", "NOT_FOUND", "RUNTIME_NOT_OURS", "RUNTIME_HAS_CREDENTIALS", "RUNTIME_SHARED", "RUNTIME_UNVERIFIED",
  "SPEC_NOT_ELIGIBLE", "ACCELERATOR_NOT_ALLOWED", "RUNTIME_CAP", "CAPACITY_UNAVAILABLE", "USAGE_LIMIT", "TOO_MANY_RUNTIMES", "RUNTIME_GONE", "RUNTIME_BUSY",
  "INTERACTIVE_UNSUPPORTED", "KERNEL_BUSY", "KERNEL_DIED", "RUN_TIMEOUT", "COLAB_UI_API", "NOTEBOOK_INVALID", "NOTEBOOK_CHANGED", "LOCAL_CHANGED",
  "PATH_REFUSED", "FILE_EXISTS", "FILE_TOO_LARGE", "UPLOAD_SECRET_REFUSED", "DRIVE_CONFLICT", "COST_CAP", "ESTIMATE_UNKNOWN", "SCHEDULE_UNBOUNDED", "SCHEDULE_OVERLAP",
  "UNCERTAIN", "BUDGET_REACHED", "JOB_FAILED", "JOB_TIMEOUT", "JOB_UNCANCELLABLE", "RESULTS_UNAVAILABLE", "SHARE_UNSUPPORTED", "ACTION_UNSUPPORTED",
  "PLAN_NOT_FOUND", "PLAN_ALREADY_USED", "PLAN_EXPIRED", "PLAN_CALLER_MISMATCH", "PLAN_CHANGED", "CATEGORY_MISMATCH", "RATE_LIMITED", "UNAVAILABLE",
]
const DESIGN_WARNINGS = ["FREE_TIER_PRIORITY", "FOREIGN_NOTEBOOK", "REVISION_PIN_SKIPPED", "EUC_RUNTIME", "IDLE_SHUTDOWN_OFF", "SCOPE_WIDER_THAN_ACCESS", "SECRET_WITHHELD", "OUTPUT_TRUNCATED", "UNHARVESTED", "DETACHED", "BUDGET_WARN", "RATES_UNKNOWN"]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) walk(path, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(path)
  }
  return out
}

describe("the error table", () => {
  it("holds design §12's codes and the Day 0 additions, and nothing else", () => {
    expect([...ERROR_CODES].sort()).toEqual([...DESIGN_CODES, ...DAY0_CODES].sort())
    expect([...WARNING_CODES].sort()).toEqual([...DESIGN_WARNINGS].sort())
  })

  it("writes `CODE: What happened. Next step: What to do.`, with the table's next step unless the raise site gives one", () => {
    expect(new ColabError("PLAN_EXPIRED").message).toBe("PLAN_EXPIRED: The plan is older than planTtlSeconds. Next step: Create a new plan.")
    const error = new ColabError("AUTH_REQUIRED", "The grant expired", { reason: "session-control", next: "Sign in again" })
    expect(error.message).toBe("AUTH_REQUIRED: The grant expired. Next step: Sign in again.")
    expect([error.state, error.reason]).toEqual(["refused", "session-control"])
  })

  it("RUNTIME_BUSY names both meanings: a run of the plugin's own, or another OpenCode process", () => {
    const text = new ColabError("RUNTIME_BUSY").message
    expect(text).toMatch(/a run of the plugin's own is active on it/)
    expect(text).toMatch(/another OpenCode process is using it/)
  })

  it("maps sign-in, scope, quota and outage codes to the source contract's", () => {
    expect(SOURCE_CODES).toMatchObject({ AUTH_REQUIRED: "NEEDS_SIGN_IN", AUTH_SCOPE_MISSING: "SCOPE_MISSING", RATE_LIMITED: "RATE_LIMITED", UNAVAILABLE: "UNAVAILABLE" })
  })

  it("docs/errors.md is what the table generates", () => {
    expect(read("docs/errors.md")).toBe(renderErrorDoc())
  })

  it("every code a source file names is in the table", () => {
    const known = new Set<string>([...ERROR_CODES, ...WARNING_CODES])
    // The source contract's and OpenCode's own codes, and Google's enum values and ErrorInfo reasons.
    const foreign = /^(NEEDS_SIGN_IN|SCOPE_MISSING|TOO_LARGE|CURSOR_\w+|SESSION_UNKNOWN|SESSION_AGENT_REQUIRED|ACCOUNT_MISMATCH|VARIANT_\w+|SHAPE_\w+|SUBSCRIPTION_TIER_\w+|JOB_STATE_\w+|ALREADY_EXISTS|FAILED_PRECONDITION|RESOURCE_EXHAUSTED|GOOGLE_APPLICATION_CREDENTIALS|ACCESS_TOKEN_SCOPE_INSUFFICIENT|XDG_STATE_HOME)$/
    const named = walk("src").flatMap((file) => [...read(file).matchAll(/["'`]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)["'`:]/g)].map((match) => [file, match[1]!] as const))
    expect(named.filter(([, code]) => !known.has(code) && !foreign.test(code))).toEqual([])
  })
})
