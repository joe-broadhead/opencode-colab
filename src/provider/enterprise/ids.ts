/**
 * Ids package E chooses: the run id of an Enterprise job (also the client-chosen `notebookExecutionJobId`, so a
 * retried create joins the first), a token for a schedule's display name (`schedules.create` has no id, design §7.2),
 * and the session label on a job.
 *
 * `notebookExecutionJobId` is an AIP-122 resource ID: lowercase letters, digits and hyphens, starting with a letter
 * (https://google.aip.dev/122, and the same shape Colab's `runtimeId` takes). `oc-job-` plus a 26-character lowercase
 * ULID is 33 characters, under the 63 AIP-122 allows. The ULID's own encoding is Crockford base32; written lowercase so
 * one id shape serves both APIs.
 */
import { createHash, randomBytes } from "node:crypto"

const ENCODING = "0123456789abcdefghjkmnpqrstvwxyz"

/** 26 characters: 48 bits of milliseconds, then 80 random bits; lowercase Crockford base32. */
export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  const time = Math.max(0, Math.min(now, 2 ** 48 - 1))
  const chars = new Array<string>(10)
  let rest = time
  for (let index = 9; index >= 0; index -= 1) {
    chars[index] = ENCODING[rest % 32]!
    rest = Math.floor(rest / 32)
  }
  const bits = new Uint8Array(16)
  let buffer = 0
  let bitsInBuffer = 0
  let out = 0
  for (const byte of random) {
    buffer = (buffer << 8) | byte
    bitsInBuffer += 8
    while (bitsInBuffer >= 5 && out < 16) {
      bits[out] = (buffer >>> (bitsInBuffer - 5)) & 31
      bitsInBuffer -= 5
      out += 1
    }
  }
  return chars.join("") + [...bits].slice(0, 16).map((value) => ENCODING[value]!).join("")
}

/** The run id of an Enterprise job, and the `notebookExecutionJobId` its create sends. */
export const jobId = (now: number = Date.now()) => `oc-job-${ulid(now)}`

/** A token that makes a schedule's display name unique, so an uncertain create can be reconciled by listing. */
export const scheduleToken = (random: Uint8Array = randomBytes(8)) =>
  [...random].map((byte) => ENCODING[byte % 32]!).join("").slice(0, 8)

/** The `oc_session` label: a short hash, so a label never carries a session id. */
export const sessionLabel = (sessionId: string) => createHash("sha256").update(sessionId).digest("hex").slice(0, 8)

/** The last segment of a resource name (`projects/p/locations/l/schedules/123` → `123`). */
export function lastSegment(name: string): string {
  const index = name.lastIndexOf("/")
  return index === -1 ? name : name.slice(index + 1)
}

/** `gs://bucket/path` → `{ bucket, prefix }`; `prefix` has no leading slash and ends with one when non-empty. */
export function gcsParts(uri: string): { readonly bucket: string; readonly prefix: string } {
  const match = /^gs:\/\/([^/]+)(?:\/(.*))?$/.exec(uri)
  if (!match) throw new Error(`not a gs:// uri: ${uri}`)
  const bucket = match[1]!
  const path = (match[2] ?? "").replace(/^\/+/, "")
  return { bucket, prefix: path === "" ? "" : `${path.replace(/\/+$/, "")}/` }
}
