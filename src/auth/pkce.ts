/**
 * PKCE (S256) and the authorization URL (design §4, Google's "OAuth 2.0 for desktop apps").
 *
 * Google's document fixes both shapes:
 * - the verifier is 43–128 unreserved characters; the challenge is `BASE64URL(SHA256(ASCII(verifier)))` with the
 *   method `S256`;
 * - the authorization endpoint is `https://accounts.google.com/o/oauth2/v2/auth`, with `response_type=code`,
 *   `client_id`, `redirect_uri`, `scope` (space-delimited), `state`, `code_challenge` and
 *   `code_challenge_method=S256`; `access_type=offline` is what returns a refresh token.
 */
import { createHash, randomBytes } from "node:crypto"

export const AUTHORIZE_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth"
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token"
/** The token method OpenCode's integration declares; the stored credential carries it. */
export const GOOGLE_METHOD_ID = "google"

export interface Pkce {
  readonly verifier: string
  readonly challenge: string
}

export function createPkce(random: (size: number) => Buffer = (size) => randomBytes(size)): Pkce {
  const verifier = random(32).toString("base64url")
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") }
}

export function createState(random: (size: number) => Buffer = (size) => randomBytes(size)): string {
  return random(32).toString("base64url")
}

export interface AuthorizeUrlInput {
  readonly clientId: string
  readonly redirectUri: string
  readonly scopes: readonly string[]
  readonly state: string
  readonly codeChallenge: string
  readonly endpoint?: string
}

export function buildAuthorizeUrl(input: AuthorizeUrlInput): string {
  const url = new URL(input.endpoint ?? AUTHORIZE_ENDPOINT)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", input.clientId)
  url.searchParams.set("redirect_uri", input.redirectUri)
  url.searchParams.set("scope", input.scopes.join(" "))
  url.searchParams.set("state", input.state)
  url.searchParams.set("code_challenge", input.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  url.searchParams.set("access_type", "offline")
  url.searchParams.set("prompt", "consent")
  return url.toString()
}
