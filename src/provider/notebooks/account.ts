/**
 * The checks a notebook tool makes before it reaches Google (design §4, Q5): Drive work needs an account signed in
 * with `drive.file` (`drive: true`), and `gs://` objects need the `cloud-platform` grant an enterprise account holds.
 * Both refusals are local, so no request leaves the machine for an account that could never be allowed.
 */
import type { Deps } from "../index.js"
import { ColabError } from "../../domain/errors.js"
import type { ResolvedAccount } from "../../options.js"

/** The one Drive scope the plugin asks for. Never `drive` or `drive.readonly` (design §4, Q5). */
export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"

export function requireDrive(account: ResolvedAccount): void {
  if (account.drive) return
  throw new ColabError("AUTH_SCOPE_MISSING", `The account "${account.alias}" was not signed in with drive.file.`, {
    next: "Set drive: true on the account and sign in again, or pull the notebook with gws and colab_download.",
  })
}

export function requireGcs(account: ResolvedAccount): void {
  if (account.backend === "enterprise") return
  throw new ColabError("AUTH_SCOPE_MISSING", `The account "${account.alias}" is a Colab account, so it has no cloud-platform grant for gs:// objects.`, {
    next: "Use an enterprise account for gs:// notebooks, or pull the notebook from Drive with colab_download.",
  })
}

/** The signed-in email, when the grant proves one; `undefined` for `token` mode and when nothing is stored. */
export async function identityEmail(account: string, deps: Pick<Deps, "auth">, signal: AbortSignal): Promise<string | undefined> {
  try {
    return (await deps.auth.identity(account, signal))?.email.toLowerCase()
  } catch {
    return undefined
  }
}
