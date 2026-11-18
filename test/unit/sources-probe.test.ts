// The source contract's `probe` (src/sources/index.ts `probeSource`, src/sources/owner.ts): whose a source is, with no
// content and no Google call; `colab.probe` asserted once on the account; never `verified: false` (v0.1.x consumers
// refuse it), a synthetic `colab:account:<alias>` owner where Google names no verified email; the contract's codes for a
// wrong account, a wrong source and a missing sign-in. And the RPC method `sourceMethods` registers.
import { probeResultProblems } from "@we-the-rebel-alliance/source-contract/events"
import { describe, expect, it } from "vitest"
import { sourceMethods } from "../../src/sources/index.js"
import { localOwner } from "../../src/sources/owner.js"
import { callOf, HOME, LAB, sourcesHarness } from "../fakes/sources-harness.js"

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as Error).message
  }
  return "no refusal"
}

describe("probe", () => {
  it("names colab.runs' owner as this computer's user, with no sign-in and no scopes", async () => {
    const h = sourcesHarness()
    h.fakes.auth.grants.delete(HOME)
    const answer = await h.probe({ source: "runs", account: HOME })
    expect(answer).toEqual({ source: "runs", account: HOME, owner: localOwner(), trust: "untrusted" })
    expect(probeResultProblems(answer, { source: "runs", account: HOME })).toEqual([])
    expect(await h.probe({ source: "colab.runs", account: HOME })).toEqual(answer)
    expect(h.permission.requests.map((request) => [request.action, request.resources])).toEqual([
      ["colab.probe", [HOME]],
      ["colab.probe", [HOME]],
    ])
  })

  it("names colab.runtimes' owner by the ID token's email and the sign-in's scopes, asserting colab.probe only", async () => {
    const h = sourcesHarness()
    const answer = await h.probe({ source: "runtimes", account: HOME })
    expect(answer).toEqual({
      source: "runtimes",
      account: HOME,
      owner: { id: "mailto:ada@example.invalid", label: "ada@example.invalid" },
      scopes: ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/colaboratory"],
      trust: "untrusted",
    })
    expect(probeResultProblems(answer, { source: "runtimes", account: HOME })).toEqual([])
    expect(h.permission.requests.map((request) => [request.action, request.resources])).toEqual([["colab.probe", [HOME]]])
    expect([...h.fakes.colab.calls, ...h.fakes.vertex.calls]).toEqual([])
  })

  it("answers for an Enterprise account's runtimes, and defaults to runs", async () => {
    const h = sourcesHarness()
    expect(await h.probe({ source: "runtimes", account: LAB })).toMatchObject({ source: "runtimes", account: LAB, owner: { id: "mailto:runner@invented-project.iam.gserviceaccount.com" } })
    expect(await h.probe({ account: HOME })).toMatchObject({ source: "runs" })
  })

  it("never answers verified: false; an unverified or missing email is the plugin's synthetic owner", async () => {
    const h = sourcesHarness()
    h.fakes.auth.identity = async (account: string) => (account === HOME ? { email: "ada@example.invalid", verified: false } : undefined)
    const unverified = (await h.probe({ source: "runtimes", account: HOME })) as { owner: Record<string, unknown> }
    expect(unverified.owner).toEqual({ id: "colab:account:home", label: "home (Google named no verified email at sign-in)" })
    const adc = (await h.probe({ source: "runtimes", account: LAB })) as { owner: Record<string, unknown> }
    expect(adc.owner).toEqual({ id: "colab:account:lab", label: "lab (Google named no verified email at sign-in)" })
    for (const answer of [unverified, adc]) expect("verified" in answer.owner).toBe(false)
  })

  it("a token account names no person, and needs its variable set", async () => {
    const h = sourcesHarness({ options: { accounts: { ci: { backend: "colab", mode: "token", tokenEnv: "COLAB_TOKEN" } } } })
    expect(await refusal(h.probe({ source: "runtimes", account: "ci" }))).toMatch(/^NEEDS_SIGN_IN: /)
    h.fakes.auth.grants.set("ci", [])
    expect(((await h.probe({ source: "runtimes", account: "ci" })) as { owner: unknown }).owner).toEqual({ id: "colab:account:ci", label: "ci (an access token from the environment; Google is not asked whose it is)" })
  })

  it("refuses an account it does not have, a source it does not have, a key it does not take, and a missing sign-in", async () => {
    const h = sourcesHarness()
    expect(await refusal(h.probe({ account: "work" }))).toMatch(/^ACCOUNT_MISMATCH: /)
    expect(await refusal(h.probe({ source: "jobs" }))).toMatch(/^SOURCE_UNKNOWN: /)
    expect(await refusal(h.probe({ source: "runs", limit: 1 }))).toMatch(/^INPUT_INVALID: /)
    expect(await refusal(h.probe({}))).toMatch(/^ACCOUNT_MISMATCH: .*none is named default/)
    h.fakes.auth.grants.delete(HOME)
    expect(await refusal(h.probe({ source: "runtimes", account: HOME }))).toMatch(/^NEEDS_SIGN_IN: /)
    // Nothing was asserted for the refusals before the account was known.
    expect(h.permission.requests.every((request) => request.action === "colab.probe")).toBe(true)
  })
})

describe("the probe as a tools RPC method", () => {
  it("is a read named probe, asserting colab.probe, and runs with the plugin's runner", async () => {
    const h = sourcesHarness()
    const [method] = sourceMethods(h.runner)
    expect(method).toMatchObject({ kind: "plugin", name: "probe", action: "colab.probe", class: "read" })
    const answer = await (method as { run: (input: unknown, call: unknown) => Promise<unknown> }).run({ account: HOME }, callOf())
    expect(answer).toMatchObject({ source: "runs", account: HOME, trust: "untrusted" })
  })

  it("answers UNAVAILABLE until Day 0 passes it the runner (contract request), never a guessed owner", async () => {
    const [method] = sourceMethods()
    expect(await refusal((method as { run: (input: unknown, call: unknown) => Promise<unknown> }).run({ account: HOME }, callOf()))).toMatch(/^UNAVAILABLE: /)
  })
})
