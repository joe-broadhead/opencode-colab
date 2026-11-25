import { describe, expect, test } from "vitest"
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import { ColabError } from "../../src/domain/errors.js"
import { asRefusal } from "../../src/handlers/errors.js"

describe("error mapping", () => {
  test.each([
    ["AUTH_REQUIRED", "NEEDS_SIGN_IN"],
    ["AUTH_SCOPE_MISSING", "SCOPE_MISSING"],
    ["RATE_LIMITED", "RATE_LIMITED"],
    ["BUDGET_REACHED", "BUDGET_EXCEEDED"],
    ["FILE_TOO_LARGE", "TOO_LARGE"],
    ["PERMISSION_DENIED", "PERMISSION_DENIED"],
    ["NOT_FOUND", "INPUT_INVALID"],
    ["RUNTIME_BUSY", "INPUT_INVALID"],
    ["UNAVAILABLE", "UNAVAILABLE"],
  ] as const)("%s becomes %s", (old, expected) => {
    expect(asRefusal(new ColabError(old)).refusal.code).toBe(expected)
  })

  test("a RegisterError passes through and an unknown error is UNAVAILABLE with its text redacted", () => {
    const own = new RegisterError(refusal("CURSOR_INVALID", "the cursor is foreign", "Read again without a cursor."))
    expect(asRefusal(own)).toBe(own)
    const mapped = asRefusal(new Error("request failed: Bearer abcdefghijklmnopqrstuvwxyz"))
    expect(mapped.refusal.code).toBe("UNAVAILABLE")
    expect(mapped.refusal.message).not.toContain("abcdefghijklmnopqrstuvwxyz")
    expect(mapped.refusal.message).toContain("Next step: ")
  })

  test("an aborted call is a clean refusal", () => {
    const error = new Error("aborted")
    error.name = "AbortError"
    expect(asRefusal(error).refusal.code).toBe("UNAVAILABLE")
    expect(asRefusal(error).refusal.message).toContain("cancelled")
  })
})
