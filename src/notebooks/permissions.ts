/**
 * The two host permission requests `colab_edit` owes in addition to its own `colab.edit` (design §6, H8): OpenCode's
 * `edit` on the path, and `external_directory` on the destination's folder when the path is outside the project.
 *
 * They are built here as plain data so the exact resources, save patterns and metadata are testable without a host.
 * `HandlerContext` carries only `providerRead` today, so `assertHostEdits` does nothing until it also carries an
 * assert; the tool's own `colab.edit` ask is the fence either way, and the requests are ready to be asserted.
 */
import { dirname } from "node:path"
import type { PermissionRequest } from "../ports.js"
import type { ToolCall } from "../tools/types.js"
import type { WorkspaceTarget } from "./paths.js"

const base = (call: ToolCall, action: string): Pick<PermissionRequest, "sessionID" | "agent" | "action" | "source"> => ({
  sessionID: call.sessionID,
  agent: call.agent,
  action,
  source: { type: "tool", messageID: call.messageID, id: call.id },
})

/** OpenCode's own `edit` ask for a notebook path, saved for that exact file. */
export function editRequest(call: ToolCall, target: WorkspaceTarget): PermissionRequest {
  return { ...base(call, "edit"), resources: [target.absolute], save: [target.absolute], metadata: { path: target.relative } }
}

/** `external_directory` for a destination outside the project: the folder's children, saved whole. */
export function externalDirectoryRequest(call: ToolCall, target: WorkspaceTarget): PermissionRequest {
  const folder = dirname(target.absolute)
  return { ...base(call, "external_directory"), resources: [`${folder}/*`], save: [`${folder}/*`], metadata: { destination: target.absolute } }
}

/** The asks `colab_edit` makes, in order: `edit`, then `external_directory` only outside the project. */
export function editRequests(call: ToolCall, target: WorkspaceTarget): PermissionRequest[] {
  return target.insideProject ? [editRequest(call, target)] : [editRequest(call, target), externalDirectoryRequest(call, target)]
}

/**
 * Asserts the requests when the host context can. `HandlerContext` has no `assert` today; the structural read means the
 * wiring starts working as soon as it does, and nothing changes before.
 */
export async function assertHostEdits(ctx: { readonly call: ToolCall; readonly assert?: (request: PermissionRequest) => Promise<void> }, target: WorkspaceTarget): Promise<void> {
  if (!ctx.assert) return
  for (const request of editRequests(ctx.call, target)) await ctx.assert(request)
}
