// Latent full-build filesystem adapter. The shipped editing entry does not import this module.
import type { ToolHandler } from "../tools/types.js"
import { applyNotebookEdit, changed, editMetadata } from "./edit-model.js"
import { withNotebookLock } from "./lock.js"
import { notebookHash } from "./model.js"
import { assertHostEdits } from "./permissions.js"
import { exists, readOptionalFile, readWorkspaceFile, refuseExisting, resolveWorkspacePath, writeWorkspaceFile } from "./paths.js"

export const edit: ToolHandler<"edit"> = {
  metadata: editMetadata,
  async run(input, ctx) {
    const target = await resolveWorkspacePath(input.path, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
    await assertHostEdits(ctx, target)
    const assertMissing = async () => {
      if (await exists(target)) refuseExisting(target, "Read it with colab_notebook and pass ifHash, or choose another path.")
    }
    return withNotebookLock(target.absolute, () => applyNotebookEdit(input, target.relative, {
      assertMissing,
      readExisting: () => readWorkspaceFile(target, ctx.deps.options.maxDownloadBytes),
      async commit(bytes, before) {
        if (before === undefined) await assertMissing()
        else {
          const current = await readOptionalFile(target)
          if (current === undefined || notebookHash(current) !== before) throw changed()
        }
        await writeWorkspaceFile(target, bytes)
      },
    }))
  },
}
