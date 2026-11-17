/**
 * The `Auth` port (src/ports.ts): one account's credential, per mode.
 *
 * - `interactive`: the credential OpenCode stores for `colab-<alias>`, refreshed when it is about to expire, with the
 *   stored grant checked against the scopes the call needs before any request leaves the machine.
 * - `adc`: an Enterprise account's Application Default Credentials, impersonating `impersonate` when set (design §4).
 * - `token`: the value of the environment variable `tokenEnv`; no refresh, and nothing proves whose token it is, so
 *   `identity()` is undefined for it (src/ports.ts).
 *
 * No token, refresh token or client secret is logged, returned in an error or put in an event; messages are built from
 * codes and account aliases, and every unexpected text goes through `redact`.
 */
import type { Auth, Clock, Identity } from "../ports.js"
import { resolveAccount, type Options, type ResolvedAccount } from "../options.js"
import { ColabError } from "../domain/errors.js"
import { integrationIdFor, integrationNames } from "./form.js"
import { refreshGoogle, type OAuthCredential } from "./google.js"
import { activeCredential, hostFor, reportNeedsSignIn, signInRequired, type AuthHost } from "./host.js"
import { readSignIn } from "./credential.js"
import { missingScopes, SCOPES } from "./scopes.js"
import { adcIdentity, adcToken, isManagedHost, type AdcEnvironment, type AdcToken } from "./adc.js"

export interface GoogleAuthEnvironment extends AdcEnvironment {
  readonly options: Options
  readonly clock: Clock
  /** A test's host; production attaches it in `registerAuth` (`host.ts`). */
  readonly host?: AuthHost
}

/** A token is refreshed this long before it expires, so a call cannot start with one that dies in flight. */
const REFRESH_SKEW_MS = 30_000

export class GoogleAuth implements Auth {
  private readonly refreshed = new Map<string, OAuthCredential>()
  private readonly adcTokens = new Map<string, AdcToken>()

  constructor(private readonly environment: GoogleAuthEnvironment) {}

  private get now(): number {
    return this.environment.clock.now().getTime()
  }

  private get fetchImpl(): typeof globalThis.fetch {
    return this.environment.fetch ?? globalThis.fetch
  }

  private account(alias: string): ResolvedAccount {
    return resolveAccount(this.environment.options, alias)
  }

  private get name(): (alias: string) => string {
    const names = integrationNames(this.environment.options.accounts)
    return (alias) => names.get(alias) ?? "Colab"
  }

  async token(account: string, scopes: readonly string[], signal: AbortSignal): Promise<string> {
    const config = this.account(account)
    if (signal.aborted) throw new ColabError("CANCELLED")
    // An Enterprise account without its project or region cannot reach Vertex; refuse before any request (design §4).
    if (config.backend === "enterprise") {
      if (!config.project || !config.region) {
        throw new ColabError("PROJECT_REQUIRED", `The enterprise account ${account} has no ${config.project ? "region" : "project"}.`, {
          next: `Set accounts.${account}.project and accounts.${account}.region in opencode.json.`,
        })
      }
    }
    // A consumer account configured read-only is never handed a token for a write scope, even if an older sign-in
    // granted one (design §4: the access setting keeps a read account from writing).
    if (config.backend === "colab" && config.access === "read" && scopes.includes(SCOPES.colaboratory)) {
      throw new ColabError("AUTH_SCOPE_MISSING", `The account ${account} is configured read-only, so it cannot request the write scope colaboratory.`, {
        next: `Set accounts.${account}.access to "write" and sign in again if this account should create or delete runtimes.`,
      })
    }
    switch (config.mode) {
      case "interactive":
        return await this.interactiveToken(config, scopes, signal)
      case "adc":
        return await this.adcToken(config, scopes, signal)
      case "token":
        return this.environmentToken(config)
    }
  }

  private async interactiveToken(account: ResolvedAccount, scopes: readonly string[], signal: AbortSignal): Promise<string> {
    const host = this.environment.host ?? hostFor(this.environment.options)
    const name = this.name(account.alias)
    if (!host) throw signInRequired(account.alias, name)
    const integrationID = integrationIdFor(account.alias)
    const active = await activeCredential(host, integrationID)
    if (!active) throw signInRequired(account.alias, name)
    let credential: OAuthCredential = toOAuth(active.credential)
    if (credential.expires <= this.now + REFRESH_SKEW_MS) {
      const cached = this.refreshed.get(account.alias)
      if (cached && cached.refresh === credential.refresh && cached.expires > this.now + REFRESH_SKEW_MS) {
        credential = cached
      } else {
        try {
          credential = await refreshGoogle({ alias: account.alias, name, credential, signal, options: { fetch: this.fetchImpl, now: () => this.now } })
          this.refreshed.set(account.alias, credential)
        } catch (error) {
          if (ColabError.is(error) && error.code === "AUTH_REQUIRED") {
            await reportNeedsSignIn(host, integrationID, active.connection, error.detail)
            throw signInRequired(account.alias, name, error.reason)
          }
          throw error
        }
      }
    }
    const signIn = readSignIn(credential.metadata)
    if (!signIn) {
      throw new ColabError("AUTH_REQUIRED", `The stored Google sign-in for ${account.alias} has no scope record, so its grant cannot be checked.`, {
        next: `Run /connect and choose ${name} again.`,
      })
    }
    const missing = missingScopes(signIn.grantedScopes, scopes)
    if (missing.length > 0) {
      throw new ColabError("AUTH_SCOPE_MISSING", `The sign-in for ${account.alias} does not hold ${missing.join(", ")}, and Google was not called.`, {
        next: `Sign in again with /connect and approve every scope, choosing ${signIn.access === "write" ? "Read and write" : "Read-only"}.`,
      })
    }
    return credential.access
  }

  private async adcToken(account: ResolvedAccount, scopes: readonly string[], signal: AbortSignal): Promise<string> {
    const env = this.environment.env ?? process.env
    if (!this.environment.options.allowAdcInHost && isManagedHost(env)) {
      throw new ColabError("ADC_REFUSED", `The account ${account.alias} uses Application Default Credentials, which a managed host refuses unless allowAdcInHost is set.`, {
        next: `Sign in interactively for ${account.alias}, or ask the operator to set allowAdcInHost: true.`,
      })
    }
    const key = `${account.alias}|${account.impersonate ?? ""}|${[...scopes].sort().join(" ")}`
    const cached = this.adcTokens.get(key)
    if (cached && cached.expiresAt > this.now + REFRESH_SKEW_MS) return cached.token
    const minted = await adcToken({
      scopes,
      ...(account.impersonate !== undefined ? { impersonate: account.impersonate } : {}),
      environment: {
        env,
        fetch: this.fetchImpl,
        now: () => this.now,
        ...(this.environment.readFile ? { readFile: this.environment.readFile } : {}),
      },
      signal,
    })
    this.adcTokens.set(key, minted)
    return minted.token
  }

  private environmentToken(account: ResolvedAccount): string {
    if (!account.tokenEnv) {
      throw new ColabError("AUTH_REQUIRED", `The account ${account.alias} is in token mode but names no variable.`, {
        next: `Set accounts.${account.alias}.tokenEnv to the name of the variable that holds the access token.`,
      })
    }
    const value = (this.environment.env ?? process.env)[account.tokenEnv]
    if (!value || !value.trim()) {
      throw new ColabError("AUTH_REQUIRED", `The variable ${account.tokenEnv} of the account ${account.alias} is empty.`, {
        next: `Set ${account.tokenEnv} in the environment, or sign in interactively with /connect.`,
      })
    }
    return value.trim()
  }

  async identity(account: string, signal: AbortSignal): Promise<Identity | undefined> {
    const config = this.account(account)
    if (signal.aborted) throw new ColabError("CANCELLED")
    if (config.mode === "token") return undefined
    if (config.mode === "adc") {
      try {
        return adcIdentity({
          ...(config.impersonate !== undefined ? { impersonate: config.impersonate } : {}),
          environment: { env: this.environment.env ?? process.env, ...(this.environment.readFile ? { readFile: this.environment.readFile } : {}) },
        })
      } catch {
        return undefined
      }
    }
    const host = this.environment.host ?? hostFor(this.environment.options)
    if (!host) return undefined
    const active = await activeCredential(host, integrationIdFor(account))
    if (!active) return undefined
    const signIn = readSignIn(active.credential.metadata)
    return signIn?.identity ? { email: signIn.identity.email, verified: signIn.identity.verified } : undefined
  }

  async scopes(account: string): Promise<readonly string[]> {
    const config = this.account(account)
    if (config.mode !== "interactive") return []
    const host = this.environment.host ?? hostFor(this.environment.options)
    if (!host) return []
    const active = await activeCredential(host, integrationIdFor(account))
    const signIn = active ? readSignIn(active.credential.metadata) : undefined
    return signIn?.grantedScopes ?? []
  }
}

/** The host's credential, narrowed to what a refresh and a scope check need. */
function toOAuth(credential: { readonly methodID?: string; readonly refresh?: string; readonly access?: string; readonly expires?: number; readonly metadata?: Readonly<Record<string, unknown>> }): OAuthCredential {
  return {
    type: "oauth",
    methodID: credential.methodID ?? "google",
    refresh: credential.refresh ?? "",
    access: credential.access ?? "",
    expires: credential.expires ?? 0,
    ...(credential.metadata !== undefined ? { metadata: credential.metadata } : {}),
  }
}
