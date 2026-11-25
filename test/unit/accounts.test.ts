import { describe, expect, test } from "vitest"
import { accountStatuses, accountsOf, resolveAccount, statusAnswer } from "@we-the-rebel-alliance/plugin-contract/accounts"
import { manifest } from "../../src/manifest.js"
import { accountsFor } from "../../src/accounts.js"

describe("accounts", () => {
  const raw = { accounts: { work: { access: "write" }, personal: {} } }

  test("the manifest reads two aliases and their profiles", () => {
    const plan = accountsOf(manifest, raw)
    expect(plan.ok).toBe(true)
    if (!plan.ok) return
    expect(plan.value.accounts.map((account) => account.alias)).toEqual(["work", "personal"])
    expect(accountsFor(manifest, raw).map((account) => account.alias)).toEqual(["work", "personal"])
  })

  test("a missing account is ACCOUNT_REQUIRED and an unknown one ACCOUNT_UNKNOWN", () => {
    const plan = accountsOf(manifest, raw)
    if (!plan.ok) throw new Error("the fixture options are invalid")
    const missing = resolveAccount(plan.value.accounts, {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe("ACCOUNT_REQUIRED")
    const unknown = resolveAccount(plan.value.accounts, { account: "nobodyhere" })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe("ACCOUNT_UNKNOWN")
  })

  test("status lists one entry per alias, ready or needing sign-in", () => {
    const statuses = accountStatuses([{ alias: "work" }, { alias: "personal" }], {
      work: { state: "ready", owner: { id: "colab:account:work", label: "work" } },
      personal: { state: "needs_sign_in" },
    })
    expect(statuses).toEqual([
      { alias: "work", state: "ready", owner: { id: "colab:account:work", label: "work" } },
      { alias: "personal", state: "needs_sign_in" },
    ])
    const answer = statusAnswer({
      manifest,
      version: "0.0.0",
      hostVersion: "2.4.1",
      accounts: statuses,
      problems: [],
      unguardedAgents: [],
    })
    expect(answer).toMatchObject({
      name: "colab",
      version: "0.0.0",
      host: { version: "2.4.1", range: ">=2.4.1 <2.5.0", tested: ["2.4.1"] },
      state: "needs_sign_in",
      accounts: statuses,
      unguardedAgents: [],
      nextStep: "Sign in to the account that needs it, then read status again.",
    })
  })

  test("a profile with an undeclared field is refused by the manifest's schema", () => {
    const plan = accountsOf(manifest, { accounts: { work: { mystery: true } } })
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.problems[0]).toContain("is not a profile field")
  })
})
