// Text from OpenCode, Google, a runtime or the network, made safe to show in status, a tool result, an error or the session.
// The rule this file exists for: a token, the runtime proxy token or URL never reaches an error, a status line, a log
// line or a result, not whole, not in part. Everything that leaves the plugin's own code, and every `catch`, goes through `redact` or
// `reasonOf` first. No imports: the terminal UI entry may inline it too. Ported from the earlier skeleton.

/**
 * Token shapes: bearer and basic values, `key=value` pairs including an `X-API-Key` header, JWTs, vendor-prefixed
 * keys, and any long run of key characters, so a token copied into an error by a transport library never survives. Callers that hold the key also cut it out by value (`withoutSecret`), which needs no guess at its shape.
 */
const SECRETS: readonly (readonly [RegExp, string])[] = [
  [/\b(bearer|basic|token)\s+[\w.~+/=-]{8,}/gi, "$1 [redacted]"],
  [
    /\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|token|secret|password|signature|credential)["']?\s*[:=]\s*)["']?[^\s"'&,;]+["']?/gi,
    "$1[redacted]",
  ],
  [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g, "[redacted]"],
  [/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|glpat|xox[abposr]|lin_api|lin_oauth)[-_][\w-]{8,}/gi, "[redacted]"],
  [/[\w+=-]{40,}/g, "[redacted]"],
]

const REASON_LIMIT = 160

/** C0 and C1 controls and DEL: a line break or escape sequence must not reach a terminal or the session. */
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]+/g
/** Bidi marks, embeddings, overrides and isolates: a name must not reorder the row it is shown in. */
const BIDI = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** A URL in text keeps its scheme, host and path: its `user:password@`, query and fragment go. */
const withoutUrlSecrets = (text: string) =>
  text.replace(/\bhttps?:\/\/[^\s"'<>]+/gi, (url) => url.replace(/^(https?:\/\/)[^/?#@]*@/i, "$1").replace(/[?#].*$/s, ""))

/** One line with no controls or bidi characters, whitespace collapsed. */
export const oneLine = (text: string) => text.replace(BIDI, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim()

/** At most `limit` characters, cut between whole characters (never inside a surrogate pair), ending in `…` when cut. */
export function cut(text: string, limit: number) {
  const characters = Array.from(text)
  return characters.length > limit ? `${characters.slice(0, limit - 1).join("")}…` : text
}

/**
 * Text safe to put in an error, a tool result or a log line: token shapes redacted, a URL's credentials, query and
 * fragment removed, one line, and nothing hidden in a control or bidi character.
 */
export function redact(text: string): string {
  return oneLine(SECRETS.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), withoutUrlSecrets(text)))
}

/**
 * Host or network text as a short reason: redacted, trailing punctuation dropped, and at most 160 characters. Undefined
 * when nothing is left, so a caller can leave the reason out rather than printing an empty bracket.
 */
export function shortReason(text: string): string | undefined {
  const reason = redact(text).replace(/[.\s]+$/, "")
  if (reason === "") return undefined
  return cut(reason, REASON_LIMIT)
}

/** An error's message, or the value itself, as a short redacted reason; `fallback` when nothing is left. */
export const reasonOf = (error: unknown, fallback = "no reason given") =>
  shortReason(error instanceof Error ? error.message : String(error)) ?? fallback

/** `text` with every occurrence of `secret` replaced, so a key echoed back by a server or a library cannot survive. */
export function withoutSecret(text: string, secret: string | undefined): string {
  if (!secret || secret.length < 4) return text
  return text.split(secret).join("[redacted]")
}

/** What replaces a secret-shaped match in shown text, exactly as design §7.5 words it. */
export const WITHHELD = "[withheld: secret-shaped]"

/**
 * The one secret screen (design §7.5), shared by package C (cell sources, outputs, Drive previews) and package E (job
 * sources): the family's token shapes above, plus the Google, cloud and vendor credentials a Colab notebook is likely
 * to hold. Patterns run in this order; a private-key block goes first so its body is not counted twice. There is no
 * hex exemption, because a 40-character hex run is also a Weights & Biases key; the one exception is a 64-hex run
 * right after `sha256:`, the plugin's own hash form.
 */
const SCREEN: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g },
  { kind: "private-key", pattern: /-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----/g },
  { kind: "service-account-key", pattern: /"type"\s*:\s*"service_account"/g },
  { kind: "aws-key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "google-client-secret", pattern: /\bGOCSPX-[0-9A-Za-z_-]{28}\b/g },
  { kind: "google-refresh-token", pattern: /\b1\/\/[0-9A-Za-z_-]{20,}/g },
  { kind: "jwt", pattern: SECRETS[2]![0] },
  { kind: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[-_][\w-]{8,}/gi },
  { kind: "huggingface-token", pattern: /\bhf_[A-Za-z0-9]{30,}/g },
  { kind: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: "vendor-token", pattern: SECRETS[3]![0] },
  // Bearer, basic and token headers: the family's shape, which also covers E's bearer kind.
  { kind: "bearer-or-basic", pattern: SECRETS[0]![0] },
  { kind: "secret-assignment", pattern: /\b(?:api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*["'][^"'\s]{8,}["']/gi },
  { kind: "key-value", pattern: /\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token|secret|password|passwd|signature|credential)["']?\s*[:=]\s*)["']?[^\s"',;&]+["']?/gi },
  { kind: "long-token", pattern: SECRETS[4]![0] },
]

const OWN_HASH = /^[0-9a-f]{64}$/

export interface SecretScreen {
  /** The text with every secret-shaped match replaced by WITHHELD. */
  readonly text: string
  /** How many matches were replaced; 0 means the text is clean. */
  readonly matches: number
  readonly found: boolean
  /** The kinds found, sorted and deduplicated; never the matched text. */
  readonly kinds: readonly string[]
}

/** Screens one piece of text. Never throws, and is stable: the same text screens the same way. */
export function screenSecrets(text: string): SecretScreen {
  let matches = 0
  const kinds = new Set<string>()
  let out = text
  for (const { kind, pattern } of SCREEN) {
    // A fresh RegExp each time, so a global pattern's lastIndex never carries over between calls.
    out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`), (match: string, ...rest: unknown[]) => {
      const offset = rest.find((value) => typeof value === "number") as number
      const whole = rest.find((value, index) => typeof value === "string" && typeof rest[index - 1] === "number") as string
      if (match.includes(WITHHELD)) return match
      if (kind === "long-token" && OWN_HASH.test(match) && whole.slice(Math.max(0, offset - 7), offset) === "sha256:") return match
      matches += 1
      kinds.add(kind)
      return WITHHELD
    })
  }
  return { text: out, matches, found: matches > 0, kinds: [...kinds].sort() }
}
