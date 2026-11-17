/**
 * The little of nbformat 4 package E needs (design §5, §9): read a local notebook for a `job.create` preview (cell count,
 * sha256, secret-screen result) and read the output notebook a job wrote to the bucket. The full notebook model is
 * package C's (`src/notebooks/*`); E cannot import it, so it keeps this narrow reader and reports nothing about a
 * notebook it cannot parse except `NOTEBOOK_INVALID`.
 *
 * A secret screen over cell sources, because a job sends the whole notebook to Google (design §7.5): the preview says
 * how many cells matched and which kinds, never the matched text. This is narrower than package C's screen; a contract
 * request asks for one screen behind a port so both packages share it.
 */
import { createHash } from "node:crypto"
import { ColabError } from "../domain/errors.js"

export interface NotebookCell {
  readonly id: string
  readonly index: number
  readonly type: "code" | "markdown" | "raw"
  readonly source: string
  readonly executionCount: number | null
  readonly outputs: readonly Readonly<Record<string, unknown>>[]
}

export interface Notebook {
  readonly nbformat: number
  readonly nbformatMinor: number
  readonly cells: readonly NotebookCell[]
  readonly kernelName?: string
  readonly language?: string
}

const text = (value: unknown): string => (typeof value === "string" ? value : Array.isArray(value) ? value.filter((part) => typeof part === "string").join("") : "")

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined)

/** nbformat 4.0–4.5; anything else is `NOTEBOOK_INVALID`. Cell ids are read when present and derived in memory when not. */
export function parseNotebook(bytes: Uint8Array): Notebook {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString("utf8"))
  } catch {
    throw new ColabError("NOTEBOOK_INVALID", "The file is not JSON, so it is not an nbformat 4 notebook.")
  }
  const root = record(parsed)
  if (!root || root.nbformat !== 4 || !Array.isArray(root.cells)) {
    throw new ColabError("NOTEBOOK_INVALID", "The file is not an nbformat 4 notebook (nbformat 4 and a cells array are required).")
  }
  const seen = new Set<string>()
  const cells = (root.cells as unknown[]).flatMap((entry, index): NotebookCell[] => {
    const cell = record(entry)
    if (!cell) return []
    const type = cell.cell_type === "code" ? "code" : cell.cell_type === "markdown" ? "markdown" : "raw"
    let id = typeof cell.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(cell.id) ? cell.id : `cell-${index}`
    if (seen.has(id)) id = `${id}-${index}`
    seen.add(id)
    const outputs = Array.isArray(cell.outputs) ? (cell.outputs.filter((output) => typeof output === "object" && output !== null) as Readonly<Record<string, unknown>>[]) : []
    return [{ id, index, type, source: text(cell.source), executionCount: typeof cell.execution_count === "number" ? cell.execution_count : null, outputs }]
  })
  const metadata = record(root.metadata)
  const kernel = record(metadata?.kernelspec)
  const language = record(metadata?.language_info)
  return {
    nbformat: 4,
    nbformatMinor: typeof root.nbformat_minor === "number" ? root.nbformat_minor : 4,
    cells,
    ...(typeof kernel?.name === "string" ? { kernelName: kernel.name } : {}),
    ...(typeof language?.name === "string" ? { language: language.name } : {}),
  }
}

export const sha256Of = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`

export interface SecretScreen {
  /** How many cells matched. */
  readonly found: number
  /** The kinds found, deduplicated; never the matched text. */
  readonly kinds: readonly string[]
}

const PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: "service-account-key", pattern: /"type"\s*:\s*"service_account"|"private_key"\s*:\s*"-----BEGIN/ },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "aws-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { kind: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { kind: "secret-assignment", pattern: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/i },
  { kind: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
]

/** The kinds of secret-shaped text in a notebook's cell sources, and how many cells carry one. */
export function secretScreen(notebook: Notebook): SecretScreen {
  const kinds = new Set<string>()
  let found = 0
  for (const cell of notebook.cells) {
    const matched = PATTERNS.filter((entry) => entry.pattern.test(cell.source))
    if (matched.length === 0) continue
    found += 1
    for (const entry of matched) kinds.add(entry.kind)
  }
  return { found, kinds: [...kinds].sort() }
}
