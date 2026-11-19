// Whether this install is a tagged release. A source checkout, a branch, or a package install with no semver tag
// answers no: tools that would call Google refuse before any request. A test may set the flag below to keep using
// the existing handlers. Production never sets it, and this file does not invent a tag.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** What the model and a script see. Does not claim a tag exists. */
export const NOT_RELEASED_DETAIL = "This install is not a tagged release, so nothing was sent to Google."
export const NOT_RELEASED_NEXT = "Install a tagged release when one exists. A source checkout does not call Google."

const FLAG = Symbol.for("@joe-broadhead/opencode-colab/tagged-release")
const SEMVER_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export interface InstallSource {
  readonly type?: string
  readonly target?: string
  readonly version?: string
  readonly path?: string
}

let observed: InstallSource | undefined

/** Record the host's description of this install. Call it before the ports are built. */
export function observeInstall(source: InstallSource | undefined): void {
  observed = source
}

/**
 * Tests, and the host harness that loads this package as a local path, set this so the existing handlers still run.
 * `undefined` clears it. Production code does not call it.
 */
export function simulateTaggedRelease(value: boolean | undefined): void {
  const target = globalThis as typeof globalThis & { [FLAG]?: boolean }
  if (value === undefined) delete target[FLAG]
  else target[FLAG] = value
}

/** True only for a real semver tag on this install, or a test that simulated one. */
export function isTaggedRelease(source: InstallSource | undefined = observed): boolean {
  const forced = (globalThis as typeof globalThis & { [FLAG]?: boolean })[FLAG]
  if (typeof forced === "boolean") return forced
  if (source?.type === "package") return packageTagged(source)
  if (source?.type === "local") return exactGitTag(source.path)
  if (source?.type === "builtin" || source?.type === "sdk") return false
  return exactGitTag(packageDir())
}

/** Read this plugin's source from `ctx.plugin.list`, if the host answers. A failure leaves the git fallback. */
export async function observeFromHost(list: unknown, pluginId: string): Promise<void> {
  if (typeof list !== "function") {
    observeInstall(undefined)
    return
  }
  const call = list as (input?: unknown) => Promise<unknown>
  try {
    observeInstall(sourceFromList(await call(), pluginId))
  } catch {
    try {
      observeInstall(sourceFromList(await call({}), pluginId))
    } catch {
      observeInstall(undefined)
    }
  }
}

/** The fetch the production ports use. A Google host is refused before `base` when this install is not tagged. */
export function guardGoogleFetch(base: typeof fetch, released: boolean, refuse: () => never): typeof fetch {
  return ((input, init) => {
    if (!released && isGoogleRequest(input)) refuse()
    return base(input, init)
  }) as typeof fetch
}

export function isGoogleRequest(input: RequestInfo | URL): boolean {
  const raw = requestUrl(input)
  if (!raw) return false
  let hostname: string
  try {
    hostname = new URL(raw).hostname
  } catch {
    return false
  }
  if (hostname === "169.254.169.254") return true
  return /(^|\.)((googleapis|googleusercontent|google)\.com|google\.internal)$/i.test(hostname)
}

function packageTagged(source: InstallSource): boolean {
  const ref = tagRef(source.target)
  if (!ref || !SEMVER_TAG.test(ref)) return false
  if (source.version !== undefined && source.version !== ref && source.version !== ref.slice(1)) return false
  return true
}

function tagRef(target: string | undefined): string | undefined {
  if (!target) return undefined
  const hash = target.lastIndexOf("#")
  if (hash === -1) return undefined
  try {
    return decodeURIComponent(target.slice(hash + 1))
  } catch {
    return target.slice(hash + 1)
  }
}

function packageDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "package.json"))) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return dirname(fileURLToPath(import.meta.url))
}

function exactGitTag(dir: string | undefined): boolean {
  if (!dir) return false
  try {
    const tag = execFileSync("git", ["-C", dir, "describe", "--exact-match", "--tags"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    return SEMVER_TAG.test(tag)
  } catch {
    return false
  }
}

function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === "string") return input
  if (input instanceof URL) return input.href
  if (typeof Request !== "undefined" && input instanceof Request) return input.url
  return undefined
}

function sourceFromList(result: unknown, pluginId: string): InstallSource | undefined {
  const items = Array.isArray(result) ? result : isRecord(result) && Array.isArray(result.data) ? result.data : []
  const mine = items.find((item) => isRecord(item) && item.id === pluginId)
  if (!isRecord(mine)) return undefined
  const source = isRecord(mine.source) ? mine.source : mine
  const type = typeof source.type === "string" ? source.type : undefined
  const target = typeof source.target === "string" ? source.target : undefined
  const version = typeof source.version === "string" ? source.version : undefined
  const path = typeof source.path === "string" ? source.path : undefined
  if (!type && !target && !path) return undefined
  return { ...(type ? { type } : {}), ...(target ? { target } : {}), ...(version ? { version } : {}), ...(path ? { path } : {}) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
