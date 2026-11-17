/**
 * The Drive branch of `colab_download` (design §6, the `DriveSync` seam): pull a notebook into the workspace, then
 * record what it came from. The destination defaults to `<workDir>/files/<name>`; an existing file needs `overwrite`,
 * and a pull **never** overwrites local edits that were not pushed (`LOCAL_CHANGED`) even with `overwrite`: push first,
 * or pull to another path. The file arrives through a temp file and a rename, and the sync record is written only after
 * the rename succeeded.
 */
import { join } from "node:path"
import { ColabError } from "../domain/errors.js"
import type { PortEnv } from "../deps.js"
import { OPERATIONS } from "../domain/actions.js"
import type { DriveApi, DriveFile, DriveSync, ProviderRead } from "../ports.js"
import { hashBytes, notebookHash, parseNotebook } from "./model.js"
import { readOptionalFile, refuseExisting, resolveWorkspacePath, writeWorkspaceFile } from "./paths.js"
import { readSyncRecord, writeSyncRecord } from "./sync.js"

const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g

/** A Drive file name as a workspace file name: no separators or controls, always `.ipynb`, at most 120 characters. */
export function safeName(name: string): string {
  const base = name.replace(UNSAFE, "-").replace(/^\.+/, "").trim() || "notebook"
  const withExtension = /\.ipynb$/i.test(base) ? base : `${base}.ipynb`
  return withExtension.length <= 120 ? withExtension : `${withExtension.slice(0, 114)}.ipynb`
}

/** The record's baseRevision when Drive did not answer one: later updates treat it as a conflict. */
const headOf = (file: DriveFile) => file.headRevisionId ?? ""

export function createDriveSync(env: PortEnv, drive: DriveApi): DriveSync {
  return {
    async pull(account, input, signal, read: ProviderRead) {
      const configured = env.options.accounts.find((entry) => entry.alias === account)
      if (configured && !configured.drive) {
        throw new ColabError("AUTH_SCOPE_MISSING", `The account "${account}" was not signed in with drive.file.`, {
          next: "Set drive: true on the account and sign in again, or pull the notebook with gws and colab_download.",
        })
      }
      // The reader that owns the calls asserts them: the metadata read and the download are `drive.files.get`.
      await read(OPERATIONS.driveFilesGet)
      const file = await drive.get(account, input.drive, signal)
      if (!file) throw new ColabError("NOT_FOUND", "Drive has no notebook the plugin may see with that id.", { next: 'colab_find({ where: "drive" }) lists the notebooks the plugin may see.' })
      const bytes = await drive.download(account, input.drive, signal)
      if (bytes.length > env.options.maxDownloadBytes) {
        throw new ColabError("FILE_TOO_LARGE", `The notebook is ${bytes.length} bytes, over the plugin's ${env.options.maxDownloadBytes}-byte cap.`)
      }
      // Refuse something that is not a notebook before it reaches the workspace.
      parseNotebook(bytes)

      const to = input.to ?? join(env.options.workDir, "files", safeName(file.name))
      const target = await resolveWorkspacePath(to, { directory: env.directory, allowedRoots: env.options.allowedRoots })
      const current = await readOptionalFile(target)
      const record = await readSyncRecord(target, env.directory, env.options.workDir)
      if (current) {
        if (!input.overwrite) refuseExisting(target, "Pass overwrite: true after the person agrees, or pull to another path.")
        if (record && notebookHash(current) !== record.baseHash) {
          throw new ColabError("LOCAL_CHANGED", "The local notebook has edits that were not pushed to Drive.", {
            next: 'Push it with colab_plan({ action: "drive.update" }) first, or pull to another path.',
          })
        }
      }

      const hash = notebookHash(bytes)
      await writeWorkspaceFile(target, bytes)
      await writeSyncRecord(target, env.directory, env.options.workDir, { fileId: file.id, baseRevision: headOf(file), baseHash: hash })
      return { state: "ok" as const, path: target.insideProject ? target.relative : target.absolute, bytes: bytes.length, sha256: hashBytes(bytes) }
    },
  }
}
