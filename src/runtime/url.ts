/**
 * The runtime URL and its proxy token are credentials (design §1, §7.4). This module is the one gate in front of them:
 *
 * - a URL is accepted only when it is https, carries no `user:password@`, and its host is on the Google-owned suffix
 *   list in discovery.ts (L2 records the exact host; anything else is RUNTIME_UNVERIFIED and the token is not
 *   sent);
 * - a token is accepted only when it is a non-empty string with no whitespace;
 * - every message built here names the problem, never the URL or the token, and `safeUrl` produces the scheme and host
 *   alone for a log or a status line if one is ever needed.
 */
import { ColabError } from "../domain/errors.js"
import type { ConnectionInfo } from "../ports.js"
import { RUNTIME_HOST_SUFFIXES } from "./discovery.js"

export interface CheckedConnection {
  readonly url: URL
  readonly token: string
  readonly expireTime: number | undefined
}

const TOKEN_SHAPE = /^\S+$/

const refused = (what: string) =>
  new ColabError("RUNTIME_UNVERIFIED", `The runtime's ${what} is not usable, so the plugin did not connect.`, {
    next: "Retry the call; if it persists, plan a fresh runtime.create.",
  })

/** True when `host` is a Google-owned host: exactly a suffix, or a subdomain of it. */
export function isAllowedRuntimeHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/\.$/, "")
  return RUNTIME_HOST_SUFFIXES.some((suffix) => lower === suffix || lower.endsWith(`.${suffix}`))
}

/**
 * The one place a `ConnectionInfo` is accepted. Never returns or throws the URL or the token; the caller keeps them in
 * memory only.
 */
export interface ConnectionChecks {
  /** Test-only: the loopback fakes serve plain http on 127.0.0.1, which production never accepts. */
  readonly allowLoopback?: boolean
}

const LOOPBACK = /^(127\.0\.0\.1|\[::1\]|localhost)$/

export function checkConnection(info: ConnectionInfo, checks: ConnectionChecks = {}): CheckedConnection {
  let url: URL
  try {
    url = new URL(info.url)
  } catch {
    throw refused("URL")
  }
  const loopback = checks.allowLoopback === true && (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.test(url.hostname)
  if (url.protocol !== "https:" && !loopback) throw refused("URL (it is not https)")
  if (url.username !== "" || url.password !== "") throw refused("URL (it carries credentials)")
  if (!loopback && !isAllowedRuntimeHost(url.hostname)) throw refused("URL (its host is not an allowed Google host)")
  if (typeof info.token !== "string" || info.token.length === 0 || !TOKEN_SHAPE.test(info.token)) throw refused("proxy token")
  const expireTime = Number.isFinite(Date.parse(info.expireTime)) ? Date.parse(info.expireTime) : undefined
  return { url, token: info.token, expireTime }
}

/** `scheme://host` only: safe for a log or a status line, and never the path, the query or the token. */
export const safeUrl = (url: URL) => `${url.protocol}//${url.host}`

/** Resolves a Jupyter path against the runtime URL, keeping the URL's own path prefix. */
export function runtimeUrl(base: URL, path: string): URL {
  const root = base.href.endsWith("/") ? base : new URL(`${base.href}/`)
  return new URL(path.replace(/^\/+/, ""), root)
}

/** The REST path for a runtime file: `content/x.csv` for `/content/x.csv`, as Jupyter Server documents paths. */
export const runtimePath = (path: string) => path.replace(/^\/+/, "")

/** The reverse: an absolute path on the runtime, as a tool result shows it. */
export const absolutePath = (path: string) => (path.startsWith("/") ? path : `/${path}`)
