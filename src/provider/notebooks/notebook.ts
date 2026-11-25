/**
 * `colab_notebook` (design §6): the structured view of a notebook from a workspace path, a Drive file (read inline,
 * nothing written), a `gs://` object, or an Enterprise run's output notebook. Sources are cut to 2,000 characters and
 * secret-screened; outputs are summarised, hidden or shown whole as asked; a sync record adds the sync state; a foreign
 * origin (Drive says someone else owns or last changed it, or `metadata.colab_origin` names another author) adds
 * warning `FOREIGN_NOTEBOOK`, which warns and never fences (design §7.3).
 *
 * What it never does: write a file, return a token or a runtime URL, or put notebook text in a `message` or a `next`.
 */
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { OPERATIONS } from "../../domain/actions.js"
import { ColabError, type WarningCode } from "../../domain/errors.js"
import type { DriveFile } from "../ports.js"
import type { HandlerContext, ToolHandler } from "../types.js"
import { identityEmail, requireDrive, requireGcs } from "./account.js"
import { notebookHash, notebookKernel, notebookOrigin, parseNotebook, selectCellIndices } from "./model.js"
import { readWorkspaceFile, resolveWorkspacePath, workDirectory, type WorkspaceTarget } from "./paths.js"
import { findSyncRecordByFileId, readSyncRecord, syncState, type SyncState } from "./sync.js"
import { cellViews, cutWithMarker, sanitizeText, secretsInView, type OutputsMode } from "./view.js"

type NotebookRef = NonNullable<Parameters<ToolHandler<"notebook">["run"]>[0]["notebook"]>

interface Loaded {
  readonly bytes: Uint8Array
  readonly driveFile?: DriveFile
  readonly target?: WorkspaceTarget
}

/** Drive says someone else owns or last changed the file. A missing `ownedByMe` and no modifier is "cannot tell". */
export function driveIsForeign(file: DriveFile, email: string | undefined): boolean {
  if (file.ownedByMe === false) return true
  if (file.lastModifyingUser !== undefined) return email === undefined || file.lastModifyingUser.toLowerCase() !== email
  return false
}

/** `metadata.colab_origin` names someone other than the signed-in person (or no identity proves otherwise). */
export function originIsForeign(origin: string | undefined, email: string | undefined): boolean {
  if (origin === undefined || origin.trim() === "") return false
  return email === undefined || origin.trim().toLowerCase() !== email
}

/** An Enterprise run's output notebook: the ledger's paths first, then the run's folder under the workDir. */
async function runNotebook(runId: string, ctx: HandlerContext): Promise<{ readonly target: WorkspaceTarget; readonly bytes: Uint8Array }> {
  const run = await ctx.deps.ledger.getRun(runId)
  if (!run) throw new ColabError("NOT_FOUND", "The ledger has no run with that id.", { next: "colab_execution lists a run's state, and colab_events_list lists finished runs." })
  // A ledger record's runId is a plugin ULID; anything else cannot name a folder under the workDir.
  const folder = /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? join(workDirectory(ctx.deps.directory, ctx.deps.options.workDir), "runs", runId) : undefined
  if (folder === undefined) throw new ColabError("NOT_FOUND", "This run has no output notebook on disk.")
  // The ledger's paths, then the name colab_execution writes; never "the first .ipynb in the folder" (a guess).
  const candidates = [...run.outputPaths.filter((path) => /\.ipynb$/i.test(path)), join(folder, "output.ipynb")]
  for (const candidate of candidates) {
    try {
      const target = await resolveWorkspacePath(candidate, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
      return { target, bytes: await readWorkspaceFile(target, ctx.deps.options.maxDownloadBytes) }
    } catch (error) {
      if (ColabError.is(error) && (error.code === "NOT_FOUND" || error.code === "PATH_REFUSED")) continue
      throw error
    }
  }
  // Several notebooks and none of them the run's: name what is there rather than picking one.
  const siblings = (await readdir(folder).catch(() => [] as string[])).filter((name) => /\.ipynb$/i.test(name)).sort()
  throw new ColabError("NOT_FOUND", siblings.length > 0 ? `The run's folder holds ${siblings.length} notebooks, and none is in the ledger or named output.ipynb.` : "This run has no output notebook on disk.", {
    next: siblings.length > 0 ? `Pick one by path with colab_notebook; the folder is .colab/runs/${runId}.` : "colab_execution({ job }) writes an Enterprise job's output notebook under the workDir, and colab_execution({ runId }) shows a run's outputs.",
  })
}

async function load(ref: NotebookRef, ctx: HandlerContext): Promise<Loaded> {
  const { deps, call } = ctx
  const maxBytes = deps.options.maxDownloadBytes
  if ("path" in ref) {
    const target = await resolveWorkspacePath(ref.path, { directory: deps.directory, allowedRoots: deps.options.allowedRoots })
    return { bytes: await readWorkspaceFile(target, maxBytes), target }
  }
  if ("run" in ref) {
    const found = await runNotebook(ref.run, ctx)
    return { bytes: found.bytes, target: found.target }
  }
  if ("drive" in ref) {
    requireDrive(ctx.account)
    await ctx.providerRead(OPERATIONS.driveFilesGet)
    const file = await deps.drive.get(ctx.account.alias, ref.drive, call.signal)
    if (!file) throw new ColabError("NOT_FOUND", "Drive has no notebook the plugin may see with that id.", { next: "colab_find({ where: \"drive\" }) lists the notebooks the plugin may see; one it never opened needs gws's export into the workspace, then colab_notebook({ path })." })
    const bytes = await deps.drive.download(ctx.account.alias, ref.drive, call.signal)
    if (bytes.length > maxBytes) throw new ColabError("FILE_TOO_LARGE", `The notebook is ${bytes.length} bytes, over the plugin's ${maxBytes}-byte cap.`)
    return { bytes, driveFile: file }
  }
  requireGcs(ctx.account)
  await ctx.providerRead(OPERATIONS.storageObjectsGet)
  const bytes = await deps.gcs.read(ctx.account.alias, ref.gcs, call.signal)
  if (bytes.length > maxBytes) throw new ColabError("FILE_TOO_LARGE", `The notebook is ${bytes.length} bytes, over the plugin's ${maxBytes}-byte cap.`)
  return { bytes }
}

export const notebook: ToolHandler<"notebook"> = {
  async run(input, ctx: HandlerContext) {
    const warnings = new Set<WarningCode>()
    const loaded = await load(input.notebook, ctx)
    const hash = notebookHash(loaded.bytes)
    const parsed = parseNotebook(loaded.bytes)
    const mode: OutputsMode = input.outputs ?? "summary"
    const indices = selectCellIndices(parsed, input.cells)
    const cells = cellViews(parsed, indices, mode)
    if (secretsInView(parsed, indices, mode)) warnings.add("SECRET_WITHHELD")

    const email = await identityEmail(ctx.account.alias, ctx.deps, ctx.call.signal)
    let sync: SyncState | undefined
    let foreign = false

    if (loaded.driveFile) {
      foreign = driveIsForeign(loaded.driveFile, email)
      const record = await findSyncRecordByFileId(loaded.driveFile.id, ctx.deps.directory, ctx.deps.options.workDir)
      sync = "none"
      if (record) {
        const local = await resolveWorkspacePath(record.localPath, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots }).catch(() => undefined)
        const localHash = local ? notebookHash(await readWorkspaceFile(local, ctx.deps.options.maxDownloadBytes)) : record.record.baseHash
        sync = syncState(record.record, localHash, loaded.driveFile.headRevisionId)
      }
    } else if (loaded.target && ctx.account.drive) {
      const record = await readSyncRecord(loaded.target, ctx.deps.directory, ctx.deps.options.workDir)
      sync = "none"
      if (record) {
        // The sync state is optional information about a file that is already in hand: a Drive failure, or a denied
        // `colab.read`, leaves the local read working without it (review LOW 1).
        try {
          await ctx.providerRead(OPERATIONS.driveFilesGet)
          const file = await ctx.deps.drive.get(ctx.account.alias, record.fileId, ctx.call.signal)
          sync = syncState(record, hash, file?.headRevisionId)
          if (file) foreign = driveIsForeign(file, email)
        } catch {
          sync = undefined
        }
      }
    }
    if (originIsForeign(notebookOrigin(parsed), email)) foreign = true
    if (foreign) warnings.add("FOREIGN_NOTEBOOK")

    const kernel = notebookKernel(parsed)
    const shownKernel = kernel ? { name: cutWithMarker(sanitizeText(kernel.name), 64), ...(kernel.language !== undefined ? { language: cutWithMarker(sanitizeText(kernel.language), 32) } : {}) } : undefined
    return {
      state: "ok" as const,
      trust: "untrusted" as const,
      hash,
      nbformat: `4.${parsed.nbformatMinor}`,
      ...(shownKernel ? { kernel: shownKernel } : {}),
      cells,
      ...(sync !== undefined ? { sync } : {}),
      ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
    }
  },
}
