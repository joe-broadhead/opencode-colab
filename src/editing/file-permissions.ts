import { isAbsolute, normalize } from "node:path"
import { ColabError } from "../domain/errors.js"
import type { WorkspaceTarget } from "../notebooks/paths.js"
import type { HostAssertRequest } from "../tools/types.js"

/** Host resources and saved permissions are patterns, not an API for escaping literal filenames. */
export function assertLiteralPermissionPath(path: string): void {
  if (!isAbsolute(path) || normalize(path) !== path || /[*?[\]{}()!:\\\u0000-\u001f\u007f]/u.test(path)) {
    throw new ColabError("PATH_REFUSED", "The absolute notebook path cannot be used as a literal OpenCode permission.", {
      next: "Use an absolute path whose directories and filename have no glob metacharacters.",
    })
  }
}

/** Save only the exact file for both checks, including external_directory; never save a folder glob. */
export function localFileRequests(target: WorkspaceTarget, action: "read" | "edit"): HostAssertRequest[] {
  assertLiteralPermissionPath(target.absolute)
  const request = (action: HostAssertRequest["action"]): HostAssertRequest => ({
    action,
    resources: [target.absolute],
    save: [target.absolute],
    metadata: { path: target.relative },
  })
  const file = request(action)
  if (target.insideProject) return [file]
  const external = request("external_directory")
  return action === "read" ? [external, file] : [file, external]
}
