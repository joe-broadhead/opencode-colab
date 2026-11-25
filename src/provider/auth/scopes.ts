/**
 * The Google scopes this plugin may request, per backend and sign-in level (design §4), and the local scope check.
 *
 * Three rules hold here:
 * - A consumer account is never asked for a Cloud scope; an Enterprise account is asked for cloud-platform, because
 *   every Vertex notebook method accepts only that scope (Vertex discovery v1 revision 20261107:
 *   `notebookExecutionJobs`, `notebookRuntimeTemplates` and `notebookRuntimes` list `cloud-platform`).
 * - `colaboratory.readonly` is not a code-execution fence: `runtimes.get` accepts it and returns the proxy token, and
 *   that token runs code (Colab discovery v1beta revision 20261115). The plugin's own classification is the fence
 *   (design §4, L4).
 * - The check runs locally, before Google is called, exactly as gws does: a token whose stored grant lacks a needed
 *   scope answers AUTH_SCOPE_MISSING and no request leaves the machine.
 *
 * No imports: the scope list is data.
 */

/** The scopes, by short name. `openid` and `userinfo.email` are identity scopes. */
export const SCOPES = {
  openid: "openid",
  email: "https://www.googleapis.com/auth/userinfo.email",
  colaboratory: "https://www.googleapis.com/auth/colaboratory",
  colaboratoryReadonly: "https://www.googleapis.com/auth/colaboratory.readonly",
  driveFile: "https://www.googleapis.com/auth/drive.file",
  cloudPlatform: "https://www.googleapis.com/auth/cloud-platform",
  aiplatform: "https://www.googleapis.com/auth/aiplatform",
  devstorageReadOnly: "https://www.googleapis.com/auth/devstorage.read_only",
} as const

export type Scope = (typeof SCOPES)[keyof typeof SCOPES]

/** Every interactive sign-in requests these, for Google's ID token and the account's email. */
export const IDENTITY_SCOPES: readonly string[] = [SCOPES.openid, SCOPES.email]

/**
 * The narrow Enterprise set design §4 allows *instead of* cloud-platform, when the Vertex notebook methods accept
 * `aiplatform` + `devstorage.read_only`. Until that is confirmed against a live project, cloud-platform is the only
 * documented scope and a read Enterprise account warns SCOPE_WIDER_THAN_ACCESS.
 */
export const ENTERPRISE_NARROW_SCOPES: readonly string[] = [SCOPES.aiplatform, SCOPES.devstorageReadOnly]

export type SignInLevel = "read" | "write"
export type Backend = "colab" | "enterprise"

/** An account shape the scope functions need; the plugin's own account config carries more. */
export interface ScopeAccount {
  readonly backend: Backend
  readonly access: SignInLevel
  /** Adds `drive.file` for a consumer account. */
  readonly drive?: boolean
  /** Extra scopes the person added, always requested and shown (design §4). */
  readonly scopes?: readonly string[]
}

const unique = (scopes: readonly string[]): string[] => [...new Set(scopes)]

/**
 * Every scope one sign-in requests, in the order the form shows them: the identity scopes, the backend's scope for the
 * level, `drive.file` when the account uses Drive, then the account's extra scopes.
 *
 * Enterprise has no read-only scope: both levels request cloud-platform (design §4).
 */
export function accountScopes(account: ScopeAccount, level: SignInLevel = account.access): string[] {
  const extra = account.scopes ?? []
  if (account.backend === "enterprise") return unique([...IDENTITY_SCOPES, SCOPES.cloudPlatform, ...extra])
  return unique([
    ...IDENTITY_SCOPES,
    level === "write" ? SCOPES.colaboratory : SCOPES.colaboratoryReadonly,
    ...(account.drive === false ? [] : [SCOPES.driveFile]),
    ...extra,
  ])
}

/**
 * The scopes write adds over read: the acknowledgment's list, and nothing when the levels request the same scopes
 * (Enterprise). Design §4's write acknowledgment names exactly these.
 */
export function writeScopes(account: ScopeAccount): string[] {
  const read = new Set(accountScopes(account, "read"))
  return accountScopes(account, "write").filter((scope) => !read.has(scope))
}

/** Short form for a message: `colaboratory.readonly`, `openid`. */
export function shortScope(scope: string): string {
  return scope.startsWith("https://www.googleapis.com/auth/") ? scope.slice("https://www.googleapis.com/auth/".length) : scope
}

export const shortScopes = (scopes: readonly string[]): string[] => scopes.map(shortScope)

/**
 * A granted scope that covers another. Google's strings are not hierarchical, so the few implications that matter are
 * named: full `colaboratory` covers every collaboratory read, and cloud-platform reaches every Cloud API, so it covers
 * the narrow Enterprise set.
 */
const IMPLIES: Readonly<Record<string, readonly string[]>> = {
  [SCOPES.colaboratory]: [SCOPES.colaboratoryReadonly],
  [SCOPES.cloudPlatform]: [SCOPES.aiplatform, SCOPES.devstorageReadOnly],
}

function covers(granted: ReadonlySet<string>, needed: string): boolean {
  if (granted.has(needed)) return true
  for (const held of granted) if (IMPLIES[held]?.includes(needed)) return true
  return false
}

/** The needed scopes the grant does not cover, in short form: empty when every one is held. */
export function missingScopes(granted: readonly string[], needed: readonly string[]): string[] {
  const held = new Set(granted)
  return shortScopes(needed.filter((scope) => !covers(held, scope)))
}

/**
 * The sorted union of every scope the plugin may request, across both backends and both levels, with and without
 * Drive: the plugin's declaration carries exactly these scopes (design §4, review L7).
 */
export const ALL_SCOPES: readonly string[] = unique([
  ...accountScopes({ backend: "colab", access: "read", drive: true }, "read"),
  ...accountScopes({ backend: "colab", access: "write", drive: true }, "write"),
  ...accountScopes({ backend: "colab", access: "read", drive: false }, "read"),
  ...accountScopes({ backend: "enterprise", access: "read" }, "read"),
  ...accountScopes({ backend: "enterprise", access: "write" }, "write"),
]).sort()

/**
 * Design §12's warning for an Enterprise read account: cloud-platform reaches more than the plugin's access level.
 * Returned as a code; the caller decides where to show it.
 */
export function widerThanAccess(account: ScopeAccount, granted: readonly string[]): boolean {
  return account.backend === "enterprise" && account.access === "read" && granted.includes(SCOPES.cloudPlatform)
}
