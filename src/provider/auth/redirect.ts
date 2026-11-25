/**
 * Where Google sends the browser back after consent (design §4, gws's relay):
 * - nothing set: a loopback redirect on a free port, `http://127.0.0.1:<port>`, which works when the browser runs on
 *   the same machine as OpenCode;
 * - `callbackPort` only: loopback on that fixed port;
 * - `redirectUri` and `callbackPort`: a host that serves OpenCode to a browser elsewhere supplies both, forwards
 *   Google's redirect unchanged to `http://127.0.0.1:<callbackPort><path>`, and the listener accepts only that path.
 *
 * Google accepts only loopback redirects for a Desktop app client and matches a Web application client's redirect
 * exactly; `client.ts` refuses a pair Google would reject before anything listens.
 */
import { ColabError } from "../../domain/errors.js"

export interface Redirect {
  /** The redirect URI Google is sent; empty until the loopback listener has its port. */
  readonly uri: string
  /** 0 means any free port. */
  readonly port: number
  /** The callback paths the listener accepts. */
  readonly paths: readonly string[]
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"])

function parse(value: string): URL | undefined {
  try {
    return new URL(value.trim())
  } catch {
    return undefined
  }
}

function invalid(detail: string): ColabError {
  return new ColabError("INPUT_INVALID", `The sign-in redirect ${detail}.`, {
    next: "Set redirectUri to an absolute https URL and callbackPort to a port from 1 to 65535, or leave both unset for a loopback redirect.",
  })
}

/** Why a redirect URI is unusable, without echoing the value. */
export function redirectProblem(value: string): string | undefined {
  const url = parse(value)
  if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return "must be an absolute http or https URL"
  if (url.username || url.password) return "must not carry a user name or password"
  if (url.hash) return "must not have a fragment"
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) return "must use https unless it points at 127.0.0.1, [::1], or localhost"
  return undefined
}

export function resolveRedirect(input: { readonly redirectUri?: string; readonly callbackPort?: number }): Redirect {
  const { redirectUri, callbackPort } = input
  if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535)) {
    throw invalid("callbackPort is not a port from 1 to 65535")
  }
  if (redirectUri === undefined || redirectUri.trim() === "") {
    const port = callbackPort ?? 0
    return { uri: port ? `http://127.0.0.1:${port}` : "", port, paths: ["/", "/callback"] }
  }
  const problem = redirectProblem(redirectUri)
  if (problem) throw invalid(`is unusable: ${problem}`)
  if (callbackPort === undefined) throw invalid("is set without callbackPort, so the local listener has no port")
  const uri = redirectUri.trim()
  return { uri, port: callbackPort, paths: [new URL(uri).pathname || "/"] }
}
