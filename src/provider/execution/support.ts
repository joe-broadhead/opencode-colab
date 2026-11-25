/**
 * Shared pieces of package D (design §5, §6, §9): ids, the "ours only" record check every runtime-scoped tool makes
 * before it reaches the transport, session names, and the small text helpers a result uses to stay plugin words only.
 *
 * The transport (package B) also refuses a runtime that is not the plugin's own, before any network call; this check
 * runs first so the tool answers with the record's own facts (gone, tainted, not ours) and so a test can prove no
 * request left the machine on a refusal. Both halves are required: H3 checks the tool's, B checks the port's.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { ColabError } from "../../domain/errors.js"
import type { RuntimeRecord, RuntimeTarget } from "../ports.js"

// ── Ids ─────────────────────────────────────────────────────────────────

/** Crockford's base32, the alphabet ULID uses (https://github.com/ulid/spec). */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz"

/** A ULID: 48-bit milliseconds, then 80 random bits, lowercase. Time-ordered, so run ids sort by start. */
export function ulid(now = Date.now()): string {
  let time = ""
  let millis = Math.floor(now)
  for (let index = 0; index < 10; index += 1) {
    time = CROCKFORD[millis % 32]! + time
    millis = Math.floor(millis / 32)
  }
  const bytes = randomBytes(16)
  let random = ""
  for (let index = 0; index < 16; index += 1) random += CROCKFORD[bytes[index]! % 32]
  return (time + random).toLowerCase()
}

/**
 * The caller-chosen runtime id (design §5): `oc-` plus a ULID, lowercase because the Colab API's `runtimeId` is
 * RFC-1034 (lowercase letters, digits and hyphens; design §18 [1]).
 */
export const runtimeId = () => `oc-${ulid()}`

/** A per-runtime nonce, kept only in the ledger; session names carry it so a session without it is foreign (§7.4). */
export const nonce = () => randomBytes(16).toString("hex")

/** A UUID4 for the Colab API's `requestId`, so a retried create joins the first instead of making a second runtime. */
export const requestId = () => randomUUID()

export const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex")
export const sha256Tag = (bytes: Uint8Array | string) => `sha256:${sha256(bytes)}`

/** The runtime id part of a resource name (`runtimes/<id>` → `<id>`). */
export const bareRuntimeId = (name: string) => name.split("/").filter(Boolean).at(-1) ?? name

// ── Session names (design §5) ───────────────────────────────────────────

/** One kernel session per (runtime, notebook) or per `session`, so variables survive between runs of the same code. */
export function sessionName(record: Pick<RuntimeRecord, "nonce">, input: { readonly notebook?: string; readonly session?: string }): string {
  const label = input.notebook !== undefined ? `nb-${sha256(input.notebook).slice(0, 12)}` : (input.session ?? "scratch")
  return `oc-${record.nonce}-${label}`
}

/** The probe's session is package B's (`oc-<nonce>-probe`); a run never uses it. */
export const PROBE_SESSION_SUFFIX = "-probe"

// ── The record check ────────────────────────────────────────────────────

export interface Ours {
  readonly record: RuntimeRecord
  readonly target: RuntimeTarget
}

/**
 * The runtime must be a record of this plugin's own, for this account, ready and untainted. A missing or foreign
 * record is RUNTIME_NOT_OURS (no override in this build), an ended one is RUNTIME_GONE, and a tainted one answers its own
 * code. This runs before any network call in every tool that names a runtime.
 */
export function ours(record: RuntimeRecord | undefined, account: string, _id: string): Ours {
  if (!record || record.account !== account) throw new ColabError("RUNTIME_NOT_OURS")
  if (record.state === "released" || record.state === "gone") throw new ColabError("RUNTIME_GONE")
  if (record.state !== "ready") throw new ColabError("RUNTIME_NOT_OURS")
  if (record.tainted) throw new ColabError(record.tainted.code)
  return { record, target: { account: record.account, runtimeId: record.id } }
}

/** The same check by id, reading the ledger first. An id the Colab API could not name is refused before the ledger. */
export async function oursById(ledger: { getRuntime(id: string): Promise<RuntimeRecord | undefined> }, account: string, id: string): Promise<Ours> {
  const record = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) ? await ledger.getRuntime(id) : undefined
  return ours(record, account, id)
}

/** The calibrated record a run needs: a runtime without a calibration was never checked, so it cannot run code. */
export function calibrated(found: Ours): Ours & { readonly calibration: NonNullable<RuntimeRecord["calibration"]> } {
  if (!found.record.calibration) {
    throw new ColabError("RUNTIME_UNVERIFIED", "The runtime has no calibration record, so the plugin cannot prove what is on it.", {
      next: "Plan a fresh runtime.create; this one is left alone.",
    })
  }
  return { ...found, calibration: found.record.calibration }
}

// ── Keep patterns ───────────────────────────────────────────────────────

/** One glob segment as a regex: `**` crosses folders, `*` and `?` stay inside one. */
function glob(pattern: string): RegExp {
  const segments = pattern.split("/")
  const parts = segments.map((segment, index) => {
    const last = index === segments.length - 1
    if (segment === "**") return last ? ".*" : "(?:[^/]+/)*"
    const body = segment.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")
    return `${body}${last ? "" : "/"}`
  })
  return new RegExp(`^${parts.join("")}$`)
}

/** `/content/outputs/**` matches the folder and everything under it (design §8.2's default `keep`). */
export function kept(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => glob(pattern).test(path))
}

// ── Plugin words only (design §7.3) ─────────────────────────────────────

/** C0/C1 controls and bidi marks out of anything a runtime or Google wrote, before it reaches a result field. */
export function safeText(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** At most `limit` characters of safe text. */
export function cut(text: string, limit: number): string {
  const characters = Array.from(safeText(text))
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : characters.join("")
}

/** A path shown in a result: relative to the project when inside it, never an absolute machine path in a message. */
export function shownPath(path: string, directory: string): string {
  const root = directory.endsWith("/") ? directory : `${directory}/`
  return path.startsWith(root) ? path.slice(root.length) : path
}

export const seconds = (ms: number) => Math.max(0, Math.round(ms / 100) / 10)
