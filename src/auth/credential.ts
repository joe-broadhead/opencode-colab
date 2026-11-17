/**
 * What a Google sign-in stores in OpenCode's credential (`metadata`), next to the tokens: the client it used, so
 * refresh keeps working when a configured client changes; the level; the scopes it requested and the scopes Google
 * granted; and the identity claims from the ID token. It is read back on every token and shown by status and the
 * doctor. The refresh token and the client secret live only in the host's credential store; the plugin writes no
 * credential file (design §4).
 */
import * as z from "zod"
import type { SignInLevel } from "./scopes.js"
import type { ClientChoice, OAuthClient } from "./client.js"

const SignInMetadata = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  clientRedirectUris: z.array(z.string()).optional(),
  clientSource: z.enum(["account", "plugin", "pasted"]),
  access: z.enum(["read", "write"]),
  requestedScopes: z.array(z.string()),
  grantedScopes: z.array(z.string()),
  identity: z.object({ email: z.string().min(1), verified: z.boolean() }).optional(),
})

export type SignInMetadata = z.output<typeof SignInMetadata>

export interface IdentityClaims {
  readonly email: string
  readonly verified: boolean
}

export function signInMetadata(input: {
  readonly client: ClientChoice
  readonly access: SignInLevel
  readonly requestedScopes: readonly string[]
  readonly grantedScopes: readonly string[]
  readonly identity?: IdentityClaims
}): SignInMetadata {
  const { redirectUris } = input.client.client
  return {
    clientId: input.client.client.clientId,
    clientSecret: input.client.client.clientSecret,
    ...(redirectUris !== undefined ? { clientRedirectUris: [...redirectUris] } : {}),
    clientSource: input.client.source,
    access: input.access,
    requestedScopes: [...input.requestedScopes],
    grantedScopes: [...input.grantedScopes],
    ...(input.identity ? { identity: { ...input.identity } } : {}),
  }
}

/** The stored sign-in, or undefined when the metadata is missing or malformed. */
export function readSignIn(metadata: Readonly<Record<string, unknown>> | undefined): SignInMetadata | undefined {
  if (!metadata) return undefined
  const parsed = SignInMetadata.safeParse(metadata)
  return parsed.success ? parsed.data : undefined
}

/** The client a stored sign-in used, so a refresh does not depend on today's configured client. */
export function signInClient(metadata: SignInMetadata): ClientChoice {
  const { clientId, clientSecret, clientRedirectUris, clientSource } = metadata
  const client: OAuthClient = { clientId, clientSecret, ...(clientRedirectUris !== undefined ? { redirectUris: clientRedirectUris } : {}) }
  return { client, source: clientSource }
}
