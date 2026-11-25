/**
 * The Drive sync record (design §5, §7.2): `.colab/sync/<path>.json`, holding `{ fileId, baseRevision, baseHash }`,
 * written by a pull or a push. It tells local changes from Drive changes:
 *
 * - `clean`: the local file and Drive's head are both what the record saw;
 * - `local-changed`: the local file moved, Drive did not;
 * - `drive-changed`: Drive moved, the local file did not;
 * - `both`: both moved.
 *
 * A record for a path outside the project (an allowed root) is kept under `sync/external/`, keyed by the path's hash,
 * so a `..` never enters a file name. A record that cannot be read is treated as absent rather than refusing the
 * notebook it describes; the next pull then asks for `overwrite` and the next update says there is no record.
 */
import { createHash } from "node:crypto"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import type { WorkspaceTarget } from "./paths.js"
import { readOptionalFile, workDirectory, writeWorkspaceFile } from "./paths.js"

export interface SyncRecord {
  readonly fileId: string
  readonly baseRevision: string
  readonly baseHash: string
}

export type SyncState = "none" | "clean" | "local-changed" | "drive-changed" | "both"

const HASH = /^sha256:[0-9a-f]{64}$/

/** Where a path's record lives: `sync/<relative path>.json`, or `sync/external/<hash>.json` outside the project. */
export function syncRecordPath(target: WorkspaceTarget, directory: string, workDir: string): string {
  const root = join(workDirectory(directory, workDir), "sync")
  if (target.insideProject && !target.relative.startsWith("..")) return join(root, `${target.relative}.json`)
  return join(root, "external", `${createHash("sha256").update(target.absolute).digest("hex").slice(0, 24)}.json`)
}

/** Reads a record; a missing, unreadable or malformed one reads as absent. */
export async function readSyncRecord(target: WorkspaceTarget, directory: string, workDir: string): Promise<SyncRecord | undefined> {
  const recordPath = syncRecordPath(target, directory, workDir)
  return parseRecord({ absolute: recordPath, relative: recordPath, insideProject: false })
}

async function parseRecord(target: WorkspaceTarget): Promise<SyncRecord | undefined> {
  const bytes = await readOptionalFile(target).catch(() => undefined)
  if (!bytes) return undefined
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Record<string, unknown>
    const { fileId, baseRevision, baseHash } = value
    if (typeof fileId !== "string" || fileId.length === 0) return undefined
    if (typeof baseRevision !== "string") return undefined
    if (typeof baseHash !== "string" || !HASH.test(baseHash)) return undefined
    return { fileId, baseRevision, baseHash }
  } catch {
    return undefined
  }
}

/** Writes a record atomically (temp file then rename). */
export async function writeSyncRecord(target: WorkspaceTarget, directory: string, workDir: string, record: SyncRecord): Promise<void> {
  const recordPath = syncRecordPath(target, directory, workDir)
  const bytes = Buffer.from(`${JSON.stringify({ fileId: record.fileId, baseRevision: record.baseRevision, baseHash: record.baseHash }, null, 1)}\n`, "utf8")
  await writeWorkspaceFile({ absolute: recordPath, relative: recordPath, insideProject: false }, bytes)
}

/**
 * The record that names a Drive file, for a `{ drive }` notebook read: the first record (by path) whose file is still
 * on disk. A record whose local copy is gone is not offered.
 */
export async function findSyncRecordByFileId(fileId: string, directory: string, workDir: string): Promise<{ readonly record: SyncRecord; readonly localPath: string } | undefined> {
  const root = join(workDirectory(directory, workDir), "sync")
  const files: string[] = []
  const walk = async (folder: string) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.name.endsWith(".json")) files.push(path)
    }
  }
  await walk(root)
  for (const path of files) {
    const record = await parseRecord({ absolute: path, relative: path, insideProject: false })
    if (!record || record.fileId !== fileId) continue
    const localPath = path.slice(root.length + 1).replace(/\.json$/, "")
    if (localPath.startsWith("external/")) continue
    const target: WorkspaceTarget = { absolute: join(directory, localPath), relative: localPath, insideProject: true }
    if (await readOptionalFile(target).then((bytes) => bytes !== undefined).catch(() => false)) return { record, localPath }
  }
  return undefined
}

/**
 * The four sync states, from the local hash and Drive's head revision. A head that is unknown (the Drive file is gone)
 * counts as moved: the local copy is no longer in step with anything.
 */
export function syncState(record: SyncRecord | undefined, localHash: string, headRevision: string | undefined): SyncState {
  if (!record) return "none"
  const local = record.baseHash === localHash
  const drive = headRevision !== undefined && record.baseRevision === headRevision
  if (local && drive) return "clean"
  if (!local && drive) return "local-changed"
  if (local && !drive) return "drive-changed"
  return "both"
}
