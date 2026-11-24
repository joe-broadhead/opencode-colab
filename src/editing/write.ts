import { randomBytes } from "node:crypto"
import { constants } from "node:fs"
import { link, lstat, open, readFile, rename, stat, statfs, unlink, type FileHandle } from "node:fs/promises"
import { basename, dirname, join, relative, sep } from "node:path"
import { ColabError } from "../domain/errors.js"
import { changed, type NotebookEditFile } from "../notebooks/edit-model.js"
import { notebookHash } from "../notebooks/model.js"
import { readRegularFile, type NotebookTarget } from "../notebooks/paths.js"

const PROCFS = 0x9fa0
const LOCAL_FILESYSTEMS = new Set([0xef53, 0x58465342, 0x9123683e, 0x01021994]) // ext family, XFS, Btrfs, tmpfs
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
const fdPath = (file: FileHandle) => `/proc/self/fd/${file.fd}`
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code
const unavailable = (detail: string) => new ColabError("EDIT_UNAVAILABLE", detail)
const alreadyExists = () => new ColabError("FILE_EXISTS")
const sameInode = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino

export function supportsBoundWrites(platform: string, hasFlags: boolean, procType: number, procInfoType: number): boolean {
  return platform === "linux" && hasFlags && procType === PROCFS && procInfoType === PROCFS
}
export const isSupportedWriteFilesystem = (type: number) => LOCAL_FILESYSTEMS.has(type)

async function mountId(file: FileHandle): Promise<string> {
  const info = await readFile(`/proc/self/fdinfo/${file.fd}`, "utf8")
  const id = /^mnt_id:\s*(\d+)$/m.exec(info)?.[1]
  if (!id) throw unavailable("The host did not report the opened folder's mount identity.")
  return id
}

/** `/proc/self/fd` gives Linux dir-relative resolution with the descriptor kept open throughout. */
async function openParent(rootPath: string, parentPath: string): Promise<FileHandle> {
  let directory = await open("/", directoryFlags)
  const descend = async (parts: string[], approvedMount?: string) => {
    for (const part of parts) {
      const next = await open(join(fdPath(directory), part), directoryFlags)
      const previous = directory
      directory = next
      await previous.close()
      if (approvedMount !== undefined && await mountId(directory) !== approvedMount) {
        throw unavailable("A notebook write cannot cross a mount below an approved root.")
      }
    }
  }
  try {
    const suffix = relative(rootPath, parentPath)
    if (suffix.split(sep).includes("..")) throw unavailable("The notebook's parent is not within the approved root.")
    await descend(rootPath.split(sep).filter(Boolean))
    const rootMount = await mountId(directory)
    if (!isSupportedWriteFilesystem((await statfs(fdPath(directory))).type)) {
      throw unavailable("The approved root is not on a supported local filesystem.")
    }
    await descend(suffix.split(sep).filter(Boolean), rootMount)
    const info = await directory.stat()
    if (info.uid !== process.geteuid?.() || (info.mode & 0o022) !== 0) {
      throw unavailable("The destination folder must be owned by this user and not writable by other users or groups.")
    }
    return directory
  } catch (error) {
    await directory.close()
    throw error
  }
}

/**
 * Binds all reads, scratch I/O and publication to the verified parent object. Reopen the path and
 * compare identities before creating scratch bytes and again before publishing. This is not a
 * guarantee that another process cannot move an already-open directory or replace a file after
 * the final check. There is no portable unchecked writer.
 */
export async function withBoundNotebook<T>(target: NotebookTarget, cap: number, signal: AbortSignal, run: (file: NotebookEditFile) => Promise<T>): Promise<T> {
  const hasFlags = [constants.O_DIRECTORY, constants.O_NOFOLLOW, constants.O_NONBLOCK].every((flag) => Number.isInteger(flag) && flag > 0)
  const procType = await statfs("/proc/self/fd").then(({ type }) => type, () => 0)
  const procInfoType = await statfs("/proc/self/fdinfo").then(({ type }) => type, () => 0)
  if (!supportsBoundWrites(process.platform, hasFlags, procType, procInfoType)) {
    throw unavailable("This host does not provide the Linux directory and procfs primitives required for notebook writes.")
  }
  const parentPath = dirname(target.absolute)
  const parent = await openParent(target.approvedRoot, parentPath).catch((error) => {
    if (ColabError.is(error)) throw error
    throw unavailable(errorCode(error) === "ENOENT" ? "The notebook's parent folder must already exist." : "The notebook's parent folder could not be safely opened.")
  })
  try {
    const anchor = fdPath(parent)
    const final = join(anchor, basename(target.absolute))
    const parentInfo = await parent.stat({ bigint: true })
    const parentMount = await mountId(parent)
    const checkParent = async () => {
      const fresh = await openParent(target.approvedRoot, parentPath).catch(() => { throw unavailable("The destination folder can no longer be verified.") })
      try {
        if (!sameInode(parentInfo, await fresh.stat({ bigint: true })) || await mountId(fresh) !== parentMount) {
          throw unavailable("The destination folder changed before the notebook could be written.")
        }
      } finally {
        await fresh.close()
      }
    }
    const read = async () => {
      const file = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
        if (errorCode(error) === "ENOENT") throw new ColabError("NOT_FOUND", "There is no notebook at that path.")
        if (errorCode(error) === "ELOOP") throw new ColabError("PATH_REFUSED", "The destination is a symbolic link.")
        throw error
      })
      try {
        if (await mountId(file) !== parentMount) throw unavailable("The notebook is on a mount below its approved root.")
        return { bytes: await readRegularFile(file, cap), info: await file.stat({ bigint: true }) }
      } finally {
        await file.close()
      }
    }
    const assertMissing = async () => {
      await lstat(final).then(() => { throw alreadyExists() }, (error) => { if (errorCode(error) !== "ENOENT") throw error })
    }
    const precondition = async (before: string | undefined) => {
      if (before === undefined) return assertMissing()
      const current = await read().catch((error) => {
        if (ColabError.is(error) && error.code === "NOT_FOUND") throw changed()
        throw error
      })
      if (notebookHash(current.bytes) !== before) throw changed()
      return current.info
    }
    return await run({
      assertMissing,
      readExisting: async () => (await read()).bytes,
      async commit(bytes, before) {
        const original = await precondition(before)
        await checkParent()
        signal.throwIfAborted()
        const scratch = join(anchor, `.colab-edit-${randomBytes(16).toString("hex")}.tmp`)
        const file = await open(scratch, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
          .catch(() => { throw unavailable("The verified destination folder does not permit a private scratch file.") })
        try {
          const scratchInfo = await file.stat({ bigint: true })
          if (await mountId(file) !== parentMount || !scratchInfo.isFile()) throw unavailable("Could not verify the notebook's scratch file.")
          await file.writeFile(bytes)
          if (original) await file.chmod(Number(original.mode & 0o777n))
          const current = await precondition(before)
          if (original && (!current || !sameInode(original, current))) throw changed()
          await checkParent()
          if (!sameInode(scratchInfo, await lstat(scratch, { bigint: true }))) throw unavailable("The notebook's scratch file changed.")
          if (before === undefined) {
            // Kernel-enforced atomic no-clobber. Never substitute rename on filesystems without hard links.
            signal.throwIfAborted()
            await link(scratch, final).catch((error) => {
              if (errorCode(error) === "EEXIST") throw alreadyExists()
              throw unavailable("The filesystem did not support atomic no-clobber publication.")
            })
          } else {
            const named = await lstat(final, { bigint: true }).catch((error) => {
              if (errorCode(error) === "ENOENT") throw changed()
              throw error
            })
            if (!current || !sameInode(current, named)) throw changed()
            signal.throwIfAborted()
            await rename(scratch, final).catch(() => { throw unavailable("The filesystem did not permit atomic notebook replacement.") })
          }
        } finally {
          const opened = await file.stat({ bigint: true }).catch(() => undefined)
          const named = await lstat(scratch, { bigint: true }).catch(() => undefined)
          if (opened && named && sameInode(opened, named)) await unlink(scratch).catch(() => undefined)
          await file.close().catch(() => undefined)
        }
      },
    })
  } finally {
    await parent.close().catch(() => undefined)
  }
}
