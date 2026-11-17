// §15.1 auth: the scope sets per backend and level, the local check, and the union Jelly's declaration carries.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { accountScopes, ALL_SCOPES, missingScopes, SCOPES, shortScopes, widerThanAccess, writeScopes } from "../../src/auth/scopes.js"

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { jelly: { signIns: { scopes: string[] }[] } }
const colab = { backend: "colab" as const, access: "write" as const, drive: true }
const enterprise = { backend: "enterprise" as const, access: "write" as const }

describe("the sign-in's scopes (design §4)", () => {
  it("§15.1 auth — a consumer account requests exactly the design's scopes at each level", () => {
    expect(accountScopes(colab, "read")).toEqual([SCOPES.openid, SCOPES.email, SCOPES.colaboratoryReadonly, SCOPES.driveFile])
    expect(accountScopes(colab, "write")).toEqual([SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile])
    expect(accountScopes({ backend: "colab", access: "read", drive: false }, "read")).toEqual([SCOPES.openid, SCOPES.email, SCOPES.colaboratoryReadonly])
    expect(accountScopes({ backend: "colab", access: "read", drive: true }, "read")).not.toContain(SCOPES.cloudPlatform)
  })

  it("§15.1 auth — write adds colaboratory for a consumer account, which the acknowledgment names", () => {
    expect(writeScopes(colab)).toEqual([SCOPES.colaboratory])
    expect(shortScopes(writeScopes(colab))).toEqual(["colaboratory"])
  })

  it("§15.1 auth — an Enterprise account requests cloud-platform at both levels, and read warns SCOPE_WIDER_THAN_ACCESS", () => {
    expect(accountScopes(enterprise, "read")).toEqual([SCOPES.openid, SCOPES.email, SCOPES.cloudPlatform])
    expect(accountScopes(enterprise, "write")).toEqual([SCOPES.openid, SCOPES.email, SCOPES.cloudPlatform])
    expect(writeScopes(enterprise)).toEqual([])
    expect(widerThanAccess({ backend: "enterprise", access: "read" }, [SCOPES.email, SCOPES.cloudPlatform])).toBe(true)
    expect(widerThanAccess({ backend: "enterprise", access: "write" }, [SCOPES.cloudPlatform])).toBe(false)
    expect(widerThanAccess({ backend: "colab", access: "read" }, [SCOPES.cloudPlatform])).toBe(false)
  })

  it("§15.1 auth — extra scopes are appended, deduplicated, and shown", () => {
    const scopes = accountScopes({ ...colab, scopes: [SCOPES.aiplatform, SCOPES.colaboratory] }, "write")
    expect(scopes.filter((scope) => scope === SCOPES.colaboratory)).toHaveLength(1)
    expect(scopes).toContain(SCOPES.aiplatform)
  })

  it("§15.1 auth — the sorted union of every scope is exactly jelly.signIns[0].scopes", () => {
    expect([...ALL_SCOPES].sort()).toEqual([...pkg.jelly.signIns[0]!.scopes].sort())
    expect(ALL_SCOPES).toContain(SCOPES.cloudPlatform)
  })

  it("§15.1 auth — the local check answers AUTH_SCOPE_MISSING's list without calling Google", () => {
    expect(missingScopes(accountScopes(colab, "read"), [SCOPES.colaboratoryReadonly])).toEqual([])
    expect(missingScopes(accountScopes(colab, "read"), [SCOPES.colaboratory])).toEqual(["colaboratory"])
    // Full colaboratory covers its read-only scope; cloud-platform covers the narrow Enterprise set.
    expect(missingScopes([SCOPES.colaboratory], [SCOPES.colaboratoryReadonly])).toEqual([])
    expect(missingScopes([SCOPES.cloudPlatform], [SCOPES.aiplatform, SCOPES.devstorageReadOnly])).toEqual([])
    expect(missingScopes([], [SCOPES.openid, SCOPES.driveFile])).toEqual(["openid", "drive.file"])
  })
})
