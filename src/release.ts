// Whether this install is a tagged release. A source checkout, a branch, or a package install with no semver tag
// answers no: tools that would call Google refuse before any request. A test may set the flag below to keep using
// the existing handlers. Production never sets it, and this file does not invent a tag.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** What the model and a script see. Does not claim a tag exists. */
export const NOT_RELEASED_DETAIL = "This install is not a tagged release, so nothing was sent to Google."
export const NOT_RELEASED_NEXT = "Install a tagged release when one exists. A source checkout does not call Google."

const FLAG = Symbol.for("@we-the-rebel-alliance/colab-plugin/tagged-release")
const SEMVER_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

export interface InstallSource {
  readonly type?: string
  readonly target?: string
  readonly version?: string
  readonly path?: string
}

/** The test seam's value, if a test set one. Production never sets it. */
function forced(): boolean | undefined {
  const value = (globalThis as typeof globalThis & { [FLAG]?: boolean })[FLAG]
  return typeof value === "boolean" ? value : undefined
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
export function isTaggedRelease(source?: InstallSource): boolean {
  const value = forced()
  if (value !== undefined) return value
  if (source?.type === "package") return packageTagged(source)
  if (source?.type === "local") return exactGitTag(source.path)
  if (source?.type === "builtin" || source?.type === "sdk") return false
  // No report: a source checkout that is exactly at a tag is a release; anything else (a package install's folder,
  // which has no .git) is not.
  return exactGitTag(packageDir())
}

/** One install's verdict, resolved from the host's own report of the plugin. */
export interface ReleaseGate {
  /** True when this install is a tagged release. Reads the host's report once its entry is there, then caches it. */
  released(): Promise<boolean>
}

/**
 * The host does not list the plugin itself while its setup runs, and a package install's folder has no .git. So the
 * verdict is read on first use, when `ctx.plugin.list` does list it: a package install's `target` carries the tag
 * (`…#v0.0.0`), and its `version` is the commit, which is ignored. A checkout at a tag stays a release; a branch, a
 * dev checkout or an install with no tag is gated. Until the entry appears, the git-tag fallback decides, which fails
 * closed for a package install.
 */
export function createReleaseGate(pluginId: string, list: () => unknown): ReleaseGate {
  let verdict: boolean | undefined
  let inflight: Promise<boolean> | undefined
  const settle = async (): Promise<boolean> => {
    const source = await sourceFromHost(list, pluginId)
    if (source === undefined) return isTaggedRelease()
    verdict = isTaggedRelease(source)
    return verdict
  }
  return {
    async released() {
      const value = forced()
      if (value !== undefined) return value
      if (verdict !== undefined) return verdict
      inflight ??= settle().finally(() => {
        inflight = undefined
      })
      return inflight
    },
  }
}

/** Read this plugin's own entry from `ctx.plugin.list`. Undefined while the host does not list it, or if it fails. */
/**
 * A host call bounded in time: a host that never answers must not hold a release decision (and the call behind it)
 * open, and a failed read leaves the git fallback, which fails closed.
 */
async function bounded(answer: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      answer,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("the host did not answer in time")), 1500)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function sourceFromHost(list: () => unknown, pluginId: string): Promise<InstallSource | undefined> {
  const target = list()
  if (typeof target !== "function") return undefined
  const call = target as (input?: unknown) => Promise<unknown>
  for (const arg of [undefined, {}]) {
    try {
      const answer = await bounded(arg === undefined ? call() : call(arg))
      return sourceFromList(answer, pluginId)
    } catch {
      // Try the other calling convention, then leave the fallback to decide.
    }
  }
  return undefined
}

/** The fetch the production ports use. A Google host is refused before `base` when this install is not tagged. */
export function guardGoogleFetch(base: typeof fetch, released: () => Promise<boolean>, refuse: () => never): typeof fetch {
  return (async (input, init) => {
    if (isGoogleRequest(input) && !(await released())) refuse()
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

/** This plugin's own repository and package: a release install comes from it, and no other one is a release here. */
const OWNER = "we-the-rebel-alliance"
const REPO = "colab-plugin"
const PACKAGE = "@we-the-rebel-alliance/colab-plugin"

function packageTagged(source: InstallSource): boolean {
  // The host reports the spec in `target` (`…#v0.0.0`) and the resolved commit in `version`; only the tag counts.
  const ref = tagRef(source.target)
  if (ref === undefined || !SEMVER_TAG.test(ref)) return false
  // A real install records where it came from: a GitHub spec must name this plugin's repository, and the installed
  // package must be this plugin, so another repo's tag (or a tag-named folder) is not a release.
  const repo = repositoryIn(source.target)
  if (repo !== undefined && (repo.owner !== OWNER || repo.name !== REPO)) return false
  return ownPackage()
}

/** The GitHub repository a package spec names, in the forms a real install records; undefined for a file or npm spec. */
function repositoryIn(target: string | undefined): { owner: string; name: string } | undefined {
  if (target === undefined) return undefined
  const spec = target.split("#")[0]!
  const match = /^(?:github:|git\+https:\/\/github\.com\/|https:\/\/github\.com\/|git\+ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?$/.exec(spec)
  return match === null ? undefined : { owner: match[1]!, name: match[2]! }
}

/** True when the installed package is this plugin's own, read from its package.json. */
function ownPackage(): boolean {
  try {
    const manifest = JSON.parse(readFileSync(join(packageDir(), "package.json"), "utf8")) as { name?: unknown }
    return manifest.name === PACKAGE
  } catch {
    return false
  }
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
