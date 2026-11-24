/**
 * The two host permission requests `colab_edit` owes in addition to its own `colab.edit` (design §6, H8): OpenCode's
 * `edit` on the path, and `external_directory` on the destination's folder when the path is outside the project. They go
 * through `HandlerContext.hostAssert`, which builds the full host request from the call; a denial from the person or the
 * agent's rules reaches the caller unchanged and nothing is written.
 *
 * They are also plain data, so the exact resources and save patterns are testable without a host.
 */
import { dirname } from "node:path"
import type { HandlerContext, HostAssertRequest } from "../tools/types.js"
import type { WorkspaceTarget } from "./paths.js"

/** `edit` on the path, then `external_directory` on its folder only outside the project. */
export function hostEditRequests(target: WorkspaceTarget): HostAssertRequest[] {
  const edit: HostAssertRequest = { action: "edit", resources: [target.absolute], save: [target.absolute], metadata: { path: target.relative } }
  if (target.insideProject) return [edit]
  const folder = dirname(target.absolute)
  return [edit, { action: "external_directory", resources: [`${folder}/*`], save: [`${folder}/*`], metadata: { destination: target.absolute } }]
}

/** Asserts each request, in order; the first denial stops the call. */
export async function assertHostEdits(ctx: Pick<HandlerContext, "hostAssert">, target: WorkspaceTarget): Promise<void> {
  for (const request of hostEditRequests(target)) await ctx.hostAssert(request)
}
