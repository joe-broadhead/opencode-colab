import { lstat, readdir, realpath } from "node:fs/promises"
import { join } from "node:path"
import type * as z from "zod"
import { ColabError } from "../domain/errors.js"
import { notebookHash, notebookKernel, parseNotebook, selectCellIndices } from "../notebooks/model.js"
import { readWorkspaceFile, resolveNotebookPath } from "../notebooks/paths.js"
import { cellViews, cutWithMarker, sanitizeText, secretsInView } from "../notebooks/view.js"
import type { notebookInput } from "./contract.js"

export function workspacePattern(pattern = "**/*.ipynb"): string[] {
  const segments = pattern.split("/")
  if (/^\/|[:\\\u0000-\u001f\u007f]/.test(pattern) || segments.some((part) => part === ".." || part === "." || part === "")) {
    throw new ColabError("INPUT_INVALID", "A workspace glob must be relative with nonempty segments.", { next: 'Use a pattern such as "**/*.ipynb".' })
  }
  return segments
}

/** Match a segment in bounded time, without compiling the caller's stars into a backtracking regex. */
function segmentMatches(pattern: string, text: string): boolean {
  let row = new Uint8Array(text.length + 1)
  row[0] = 1
  for (const char of pattern.split("")) {
    const next = new Uint8Array(row.length)
    if (char === "*") next[0] = row[0]!
    for (let j = 1; j < row.length; j++) {
      next[j] = char === "*" ? row[j]! | next[j - 1]! : char === "?" || char === text[j - 1] ? row[j - 1]! : 0
    }
    row = next
  }
  return row[text.length] === 1
}

function matches(pattern: string[], parts: string[]): boolean {
  let row = new Uint8Array(parts.length + 1)
  row[0] = 1
  for (const segment of pattern) {
    const next = new Uint8Array(row.length)
    if (segment === "**") next[0] = row[0]!
    for (let j = 1; j < row.length; j++) {
      next[j] = segment === "**" ? row[j]! | next[j - 1]! : row[j - 1] && segmentMatches(segment, parts[j - 1]!) ? 1 : 0
    }
    row = next
  }
  return row[parts.length] === 1
}

export async function findLocal(directory: string, pattern: string[], limit = 50, signal: AbortSignal) {
  const notebooks: { where: "workspace"; path: string; name: string; modified?: string }[] = []
  const pending: string[][] = [[]]
  let seen = 0
  while (pending.length > 0) {
    signal.throwIfAborted()
    const parts = pending.pop()!
    const folder = join(directory, ...parts)
    const actual = await realpath(folder).catch((error: NodeJS.ErrnoException) => {
      if (parts.length > 0 && ["EACCES", "ENOENT", "ENOTDIR", "ELOOP"].includes(error.code ?? "")) return undefined
      throw error
    })
    if (actual !== folder) {
      if (parts.length === 0) throw new ColabError("PATH_REFUSED", "The workspace is not a canonical local directory.")
      continue
    }
    const entries = await readdir(folder, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "EACCES" || error.code === "ENOENT" || error.code === "ENOTDIR") return []
      throw error
    })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (++seen > 20_000) return { state: "ok", trust: "untrusted", notebooks, truncated: true }
      if (entry.name.startsWith(".") || /[:\\\u0000-\u001f\u007f]/.test(entry.name)) continue
      const path = [...parts, entry.name]
      if (entry.isDirectory() && entry.name !== "node_modules") pending.push(path)
      if (!entry.isFile() || !/\.ipynb$/i.test(entry.name) || !matches(pattern, path)) continue
      const info = await lstat(join(folder, entry.name)).catch(() => undefined)
      if (!info?.isFile()) continue
      if (notebooks.length === limit) return { state: "ok", trust: "untrusted", notebooks, truncated: true }
      notebooks.push({ where: "workspace", path: path.join("/"), name: entry.name, modified: info.mtime.toISOString() })
    }
  }
  return { state: "ok", trust: "untrusted", notebooks }
}

export async function readLocal(
  input: z.output<typeof notebookInput>,
  options: { directory: string; allowedRoots: readonly string[]; maxDownloadBytes: number },
) {
  const target = await resolveNotebookPath(input.notebook.path, options)
  const bytes = await readWorkspaceFile(target, options.maxDownloadBytes)
  const notebook = parseNotebook(bytes)
  const mode = input.outputs ?? "summary"
  const indices = selectCellIndices(notebook, input.cells)
  const kernel = notebookKernel(notebook)
  return {
    state: "ok",
    trust: "untrusted",
    hash: notebookHash(bytes),
    nbformat: `4.${notebook.nbformatMinor}`,
    ...(kernel ? { kernel: { name: cutWithMarker(sanitizeText(kernel.name), 64), ...(kernel.language === undefined ? {} : { language: cutWithMarker(sanitizeText(kernel.language), 32) }) } } : {}),
    cells: cellViews(notebook, indices, mode),
    ...(secretsInView(notebook, indices, mode) ? { warnings: ["SECRET_WITHHELD"] } : {}),
  }
}
