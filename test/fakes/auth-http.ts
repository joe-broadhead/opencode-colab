/**
 * A recording `fetch` for Google's endpoints, and the fixtures the auth tests use: an OAuth credential with its stored
 * metadata, an unsigned ID token with Google's claims, and a throwaway RSA service account key (generated in the test
 * process; nothing here is a real credential).
 */
import { generateKeyPairSync } from "node:crypto"
import { signInMetadata } from "../../src/auth/credential.js"
import type { HostCredential } from "../../src/auth/host.js"
import type { OAuthCredential } from "../../src/auth/google.js"

export interface HttpCall {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

interface Route {
  readonly matches: (url: URL) => boolean
  readonly respond: (call: HttpCall) => Response | Promise<Response>
}

export class FakeHttp {
  readonly calls: HttpCall[] = []
  private readonly routes: Route[] = []

  route(matches: (url: URL) => boolean, respond: (call: HttpCall) => Response | Promise<Response>): this {
    this.routes.push({ matches, respond })
    return this
  }

  /** One route for a path on a host; `status` and a JSON body (or text). */
  on(host: string, path: string, status: number, body: unknown): this {
    return this.route(
      (url) => url.host === host && url.pathname === path,
      () => jsonResponse(status, body),
    )
  }

  get fetch(): typeof globalThis.fetch {
    return Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = new Request(input, init)
        const body = request.method === "POST" || request.method === "PUT" ? await request.text() : ""
        const headers: Record<string, string> = {}
        request.headers.forEach((value, key) => {
          headers[key.toLowerCase()] = value
        })
        const call: HttpCall = { url: request.url, method: request.method, headers, body }
        this.calls.push(call)
        const url = new URL(request.url)
        for (const route of this.routes) if (route.matches(url)) return route.respond(call)
        throw new Error(`FakeHttp: no route for ${request.method} ${request.url}`)
      },
      { preconnect: () => undefined },
    ) as typeof globalThis.fetch
  }
}

export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  })
}

/** A token response Google's token endpoint documents: access_token, expires_in, refresh_token, scope, id_token. */
export function tokenResponse(input: { access?: string; refresh?: string; expiresIn?: number; scopes?: readonly string[]; idToken?: string } = {}): Record<string, unknown> {
  return {
    access_token: input.access ?? "ya29.test-access-token",
    expires_in: input.expiresIn ?? 3600,
    token_type: "Bearer",
    ...(input.refresh ? { refresh_token: input.refresh } : {}),
    ...(input.scopes ? { scope: input.scopes.join(" ") } : {}),
    ...(input.idToken ? { id_token: input.idToken } : {}),
  }
}

export function formBody(call: HttpCall): URLSearchParams {
  return new URLSearchParams(call.body)
}

export function b64url(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url")
}

/** An ID token with Google's claims; the signature is a placeholder, because the flow does not re-verify it. */
export function idToken(input: { email?: string; emailVerified?: boolean; clientId?: string; issuer?: string; expiresInSec?: number; now?: number } = {}): string {
  const now = input.now ?? Date.now()
  const claims = {
    iss: input.issuer ?? "https://accounts.google.com",
    aud: input.clientId ?? "123456789012-colabtest.apps.googleusercontent.com",
    sub: "10769150350006150715113082367",
    email: input.email ?? "person@example.com",
    email_verified: input.emailVerified ?? true,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + (input.expiresInSec ?? 3600),
  }
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(claims)}.signature-not-checked`
}

/** The host credential one sign-in stores: tokens plus the metadata schema (client, level, scopes, identity). */
export function storedCredential(input: {
  readonly clientId?: string
  readonly clientSecret?: string
  readonly access?: "read" | "write"
  readonly granted?: readonly string[]
  readonly requested?: readonly string[]
  readonly refresh?: string
  readonly accessToken?: string
  readonly expiresInMs?: number
  readonly email?: string
  readonly verified?: boolean
  readonly now?: number
} = {}): OAuthCredential {
  const now = input.now ?? Date.now()
  const client = { clientId: input.clientId ?? "123456789012-colabtest.apps.googleusercontent.com", clientSecret: input.clientSecret ?? "GOCSPX-test-client-secret" }
  const granted = input.granted ?? ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"]
  const identity = input.email ? { email: input.email, verified: input.verified ?? true } : undefined
  return {
    type: "oauth",
    methodID: "google",
    refresh: input.refresh ?? "1//test-refresh-token",
    access: input.accessToken ?? "ya29.test-access-token",
    expires: now + (input.expiresInMs ?? 3600_000),
    metadata: signInMetadata({
      client: { client, source: "pasted" },
      access: input.access ?? "write",
      requestedScopes: input.requested ?? granted,
      grantedScopes: granted,
      ...(identity ? { identity } : {}),
    }) as unknown as Record<string, unknown>,
  }
}

/** A throwaway service account key, generated here: no real key is stored anywhere. */
export function serviceAccountKey(input: { email?: string } = {}): { client_email: string; private_key: string; private_key_id: string; type: "service_account" } {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } })
  return { type: "service_account", client_email: input.email ?? "colab-runner@example-project.iam.gserviceaccount.com", private_key: privateKey, private_key_id: "test-key-id" }
}
