// §15.1 auth: PKCE (S256), the state, and the authorization URL Google documents for a desktop app.
import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { AUTHORIZE_ENDPOINT, buildAuthorizeUrl, createPkce, createState } from "../../src/provider/auth/pkce.js"
import { SCOPES } from "../../src/provider/auth/scopes.js"

describe("PKCE and the authorization URL (design §4)", () => {
  it("§15.1 auth — the challenge is BASE64URL(SHA256(verifier)) with method S256, and the verifier is 43–128 unreserved characters", () => {
    const { verifier, challenge } = createPkce()
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    const second = createPkce()
    expect(second.verifier).not.toBe(verifier)
    expect(second.challenge).not.toBe(challenge)
  })

  it("§15.1 auth — the state is random and URL-safe", () => {
    const state = createState()
    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(createState()).not.toBe(state)
  })

  it("§15.1 auth — the URL carries every parameter Google requires, the exact scopes, and no client secret", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "123456789012-abc.apps.googleusercontent.com",
        redirectUri: "http://127.0.0.1:9004",
        scopes: [SCOPES.openid, SCOPES.email, SCOPES.colaboratory],
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    )
    expect(url.origin + url.pathname).toBe(AUTHORIZE_ENDPOINT)
    expect(url.searchParams.get("response_type")).toBe("code")
    expect(url.searchParams.get("client_id")).toBe("123456789012-abc.apps.googleusercontent.com")
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9004")
    expect(url.searchParams.get("scope")).toBe(`${SCOPES.openid} ${SCOPES.email} ${SCOPES.colaboratory}`)
    expect(url.searchParams.get("state")).toBe("state-value")
    expect(url.searchParams.get("code_challenge")).toBe("challenge-value")
    expect(url.searchParams.get("code_challenge_method")).toBe("S256")
    expect(url.searchParams.get("access_type")).toBe("offline")
    expect(url.searchParams.get("prompt")).toBe("consent")
    expect(url.toString()).not.toContain("secret")
  })
})
