// Package A, Auth (docs/v1-design.md, File ownership): the `colab-<alias>` integrations and their form, PKCE, the
// relay, client precedence, `id_token`; ADC, impersonation and token mode for enterprise accounts; local scope checks;
// the session-control mapping; `/colab-doctor`. Day 0 stub: not signed in, and every token answers NOT_IMPLEMENTED.
import type { Options } from "../options.js"
import type { Auth, Clock } from "../ports.js"
import { notImplemented } from "../stub.js"

export interface AuthEnv {
  readonly options: Options
  readonly clock: Clock
}

export function createAuth(_env: AuthEnv): Auth {
  return {
    token: async (account) => notImplemented(`Sign-in for ${account}`),
    identity: async () => undefined,
    scopes: async () => [],
  }
}

/** The host registrations A owns (integrations, `/colab-doctor`). Day 0 registers nothing. */
export async function registerAuth(_ctx: unknown, _env: AuthEnv): Promise<{ dispose(): Promise<void> }> {
  return { dispose: async () => undefined }
}
