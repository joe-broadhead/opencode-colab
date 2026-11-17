/**
 * The source and output secret screen of design §7.5: secret-shaped text in a cell source or an inline output is
 * replaced with `[withheld: secret-shaped]` and the caller adds warning `SECRET_WITHHELD`. It screens what is *shown*;
 * the bytes stay in the file and an upload or push is not blocked (the previews say what was found instead).
 *
 * The patterns are the family's redaction shapes (src/redact.ts, opencode-gws's upstreamText) plus the Google
 * credential shapes a Colab notebook is likely to hold. One deliberate difference: a long run that is pure lowercase
 * hex of 40–64 characters is left alone, because a sha256 in a notebook is a checksum far more often than it is a key
 * (Drive's revision ids are also hex). Every other long run is withheld, as the family does.
 */

/** What replaces a match, exactly as design §7.5 words it. */
export const WITHHELD = "[withheld: secret-shaped]"

/** PEM private keys, whole blocks: service-account JSON embeds one. */
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g
/** AWS access key ids. */
const AWS_ACCESS_KEY = /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g
/** Google API keys (`AIza` + 35 characters). */
const GOOGLE_API_KEY = /\bAIza[0-9A-Za-z_-]{35}\b/g
/** Google OAuth client secrets (`GOCSPX-` + 28 characters). */
const GOOGLE_CLIENT_SECRET = /\bGOCSPX-[0-9A-Za-z_-]{28}\b/g
/** Google OAuth refresh tokens. */
const GOOGLE_REFRESH_TOKEN = /\b1\/\/[0-9A-Za-z_-]{20,}/g
/** JSON Web Tokens, the shape of an id_token. */
const JWT = /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]{4,}/g
/** GitHub tokens. */
const GITHUB = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)[-_][\w-]{8,}/gi
/** OpenAI-style keys. */
const OPENAI = /\bsk-[A-Za-z0-9_-]{20,}\b/g
/** Slack tokens. */
const SLACK = /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g
/** `Authorization: Bearer …` and its siblings. */
const AUTH_HEADER = /\b(?:bearer|basic|token)\s+[\w.~+/=-]{8,}/gi
/** `key = value` and `"key": "value"` assignments whose key names a credential. */
const ASSIGNMENT = /\b([\w-]*(?:api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|token|secret|password|passwd|signature|credential)["']?\s*[:=]\s*)["']?[^\s"',;&]+["']?/gi
/** The family's catch-all: any long run of key characters. */
const LONG_RUN = /[\w+=-]{40,}/g

/** Every pattern, in replacement order; the private-key block goes first so its body is not counted twice. */
const PATTERNS: readonly RegExp[] = [PRIVATE_KEY, AWS_ACCESS_KEY, GOOGLE_API_KEY, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN, JWT, GITHUB, OPENAI, SLACK, AUTH_HEADER, ASSIGNMENT, LONG_RUN]

/** A lowercase hex run of 40–64 characters: a checksum (a sha256 is 64), not a credential. */
const CHECKSUM = /^[0-9a-f]{40,64}$/

export interface SecretScreen {
  /** The text with every secret-shaped match replaced. */
  readonly text: string
  /** How many matches were replaced; 0 means the text is clean. */
  readonly matches: number
}

/** Screens one piece of notebook text. Never throws, and is stable: the same text screens the same way. */
export function screenSecrets(text: string): SecretScreen {
  let matches = 0
  let out = text
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match: string) => {
      if (pattern === LONG_RUN && CHECKSUM.test(match)) return match
      matches += 1
      return WITHHELD
    })
  }
  return { text: out, matches }
}
