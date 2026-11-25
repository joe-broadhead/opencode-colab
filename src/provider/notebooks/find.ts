/**
 * `colab_find` (design §6): notebooks in the workspace (a glob), in Drive (files the plugin may see under `drive.file`,
 * filtered to Colab's notebook MIME type) or under a `gs://` prefix on an enterprise account.
 *
 * Drive query shapes come from the Drive API v3 guide "Search for files and folders": `name contains 'x'` (an
 * apostrophe or a backslash in the value is escaped with a backslash, as the guide's own example shows), `mimeType =`
 * and `trashed = false`; `pageSize` is at most 1000 (files.list reference), and the plugin's own cap is 200. The Colab
 * notebook MIME type `application/vnd.google.colaboratory` is the design's §1 value; the Drive API uses it for Colab
 * notebooks.
 */
import { readdir, stat } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import { OPERATIONS } from "../../domain/actions.js"
import { ColabError } from "../../domain/errors.js"
import type { HandlerContext, ToolHandler } from "../types.js"
import { requireDrive, requireGcs } from "./account.js"
import { resolveWorkspacePath, workDirectory } from "./paths.js"

/** The MIME type a Colab notebook has in Drive (design §1). */
export const COLAB_MIME = "application/vnd.google.colaboratory"
const NOTEBOOK = /\.ipynb$/i
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const SKIP_DIRECTORIES = new Set(["node_modules"])
/** The walk's bound: a pathological tree ends as a truncated page, never a hang. */
const MAX_ENTRIES = 20_000

interface Found {
  readonly where: "workspace" | "drive" | "gcs"
  readonly path?: string
  readonly drive?: string
  readonly gcs?: string
  readonly name: string
  readonly modified?: string
  readonly owner?: string
}

/** Escapes a value inside a single-quoted Drive query term, as the search guide does. */
export function driveQuery(pattern: string | undefined): string {
  const terms = [`mimeType = '${COLAB_MIME}'`, "trashed = false"]
  if (pattern !== undefined && pattern.trim() !== "") terms.push(`name contains '${pattern.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`)
  return terms.join(" and ")
}

// ── The workspace glob ──────────────────────────────────────────────────

/** `*` and `?` inside one path segment; everything else is literal. `**` is handled a segment at a time. */
function segmentMatcher(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")
  return new RegExp(`^${escaped}$`)
}

function matches(pattern: readonly string[], path: readonly string[]): boolean {
  if (pattern.length === 0) return path.length === 0
  const [head, ...rest] = pattern
  if (head === "**") return matches(rest, path) || (path.length > 0 && matches(pattern, path.slice(1)))
  if (path.length === 0) return false
  return segmentMatcher(head!).test(path[0]!) && matches(rest, path.slice(1))
}

function compileGlob(pattern: string): string[] | undefined {
  if (pattern.startsWith("/") || pattern.split(/[\\/]/).includes("..")) return undefined
  return pattern.replace(/\\/g, "/").split("/").filter((segment) => segment.length > 0)
}

/** Both the project and the workDir's downloads are searched; a huge tree stops at the bound instead of hanging. */
async function walkWorkspace(root: string, pattern: string, limit: number, downloads: string | undefined): Promise<{ readonly found: Found[]; readonly truncated: boolean }> {
  const segments = compileGlob(pattern)
  if (!segments) throw new ColabError("INPUT_INVALID", "A workspace pattern is relative and has no .. segment.", { next: 'Use a pattern such as "**/*.ipynb".' })
  const found: Found[] = []
  let truncated = false
  let seen = 0
  const visit = async (folder: string, allowDot: boolean) => {
    if (seen > MAX_ENTRIES) {
      truncated = true
      return
    }
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!allowDot && entry.name.startsWith(".")) continue
      if (entry.name === "." || entry.name === "..") continue
      seen += 1
      if (seen > MAX_ENTRIES) {
        truncated = true
        return
      }
      const absolute = join(folder, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) await visit(absolute, allowDot)
        continue
      }
      if (!entry.isFile() || !NOTEBOOK.test(entry.name)) continue
      const path = relative(root, absolute).split(sep).join("/")
      if (!matches(segments, path.split("/"))) continue
      if (found.length >= limit) {
        truncated = true
        return
      }
      const info = await stat(absolute).catch(() => undefined)
      if (!found.some((entry) => entry.path === path)) found.push({ where: "workspace", path, name: entry.name, ...(info ? { modified: info.mtime.toISOString() } : {}) })
    }
  }
  await visit(root, false)
  // A pulled notebook lives under the workDir, which the project walk skips as a dot folder.
  if (downloads !== undefined && !truncated) await visit(downloads, true)
  found.sort((a, b) => (a.path ?? "").localeCompare(b.path ?? ""))
  return { found, truncated }
}

// ── The handler ─────────────────────────────────────────────────────────

export const find: ToolHandler<"find"> = {
  async run(input, ctx: HandlerContext) {
    const limit = Math.min(input.limit ?? DEFAULT_LIMIT, MAX_LIMIT)
    const signal = ctx.call.signal
    let notebooks: Found[]
    let truncated = false

    if (input.where === "workspace") {
      const root = await resolveWorkspacePath(".", { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
      const walked = await walkWorkspace(root.absolute, input.pattern ?? "**/*.ipynb", limit, join(workDirectory(ctx.deps.directory, ctx.deps.options.workDir), "files"))
      notebooks = walked.found
      truncated = walked.truncated
    } else if (input.where === "drive") {
      requireDrive(ctx.account)
      await ctx.providerRead(OPERATIONS.driveFilesList)
      const files = await ctx.deps.drive.list(ctx.account.alias, { query: driveQuery(input.pattern), pageSize: limit }, signal)
      // owner is Drive's last modifying user: the port asks for `lastModifyingUser(emailAddress)`, not `owners`.
      notebooks = files.map((file) => ({
        where: "drive" as const,
        drive: file.id,
        name: file.name,
        ...(file.modifiedTime !== undefined ? { modified: file.modifiedTime } : {}),
        ...(file.lastModifyingUser !== undefined ? { owner: file.lastModifyingUser } : {}),
      }))
      truncated = notebooks.length >= limit
    } else {
      requireGcs(ctx.account)
      const prefix = input.prefix ?? ctx.account.outputBucket
      if (prefix === undefined) throw new ColabError("BUCKET_REQUIRED", "An enterprise account needs outputBucket to search gs:// without a prefix.")
      await ctx.providerRead(OPERATIONS.storageObjectsList)
      const objects = await ctx.deps.gcs.list(ctx.account.alias, prefix, signal)
      const matching = objects.filter((object) => NOTEBOOK.test(object.uri)).sort((a, b) => a.uri.localeCompare(b.uri))
      truncated = matching.length > limit
      notebooks = matching.slice(0, limit).map((object) => ({
        where: "gcs" as const,
        gcs: object.uri,
        name: basename(object.uri),
        ...(object.updated !== undefined ? { modified: object.updated } : {}),
      }))
    }

    return {
      state: "ok" as const,
      trust: "untrusted" as const,
      notebooks,
      ...(truncated ? { truncated: true } : {}),
    }
  },
}
