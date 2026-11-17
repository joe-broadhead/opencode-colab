/**
 * Workspace paths (design §6, §12 `PATH_REFUSED` / `FILE_EXISTS` / `FILE_TOO_LARGE`): a notebook path resolves inside
 * the project or one of `allowedRoots`, never through a symbolic link, and every write is a temp file plus a rename, so
 * a failed write never leaves a half-written notebook. The project directory is `deps.directory` (OpenCode's
 * `ctx.location.directory`); `workDir` is relative to it.
 */
import { randomBytes } from "node:crypto"
import { lstat, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { ColabError } from "../domain/errors.js"
import { redact } from "../redact.js"

export interface WorkspaceTarget {
  /** The absolute path, normalized. */
  readonly absolute: string
  /** Relative to the project when inside it; otherwise the absolute path. */
  readonly relative: string
  readonly insideProject: boolean
}

interface PathOptions {
  readonly directory: string
  readonly allowedRoots: readonly string[]
}

const under = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

function refused(detail: string, next = "Use a path inside the project, or add its folder to the plugin's allowedRoots option."): never {
  throw new ColabError("PATH_REFUSED", detail, { next })
}

/**
 * Walks the existing part of the path from its root and refuses the first symbolic link, so a link inside the project
 * cannot lead a read or a write outside it. Components that do not exist yet are allowed (a `colab_edit` create makes
 * its folder).
 */
async function refuseSymlinks(root: string, absolute: string): Promise<void> {
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  let current = root
  for (const part of parts) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) refused("The path is, or passes through, a symbolic link.")
      if (current !== absolute && !info.isDirectory()) refused("A component of the path is not a folder.")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return
      throw error
    }
  }
}

/** Resolves a path a call named, with every check the plugin makes before it reads or writes one. */
export async function resolveWorkspacePath(path: string, options: PathOptions): Promise<WorkspaceTarget> {
  if (path.length === 0 || path.includes("\u0000")) refused("The path is empty or contains a NUL character.")
  const project = normalize(isAbsolute(options.directory) ? options.directory : resolve(options.directory))
  const absolute = normalize(isAbsolute(path) ? path : resolve(project, path))
  const roots = [project, ...options.allowedRoots.map((root) => normalize(isAbsolute(root) ? root : resolve(project, root)))]
  const root = roots.find((candidate) => under(candidate, absolute))
  if (root === undefined) refused(`The path "${redact(path)}" is outside the project and its allowed roots.`)
  await refuseSymlinks(root, absolute)
  const insideProject = under(project, absolute)
  return { absolute, relative: insideProject ? relative(project, absolute) : absolute, insideProject }
}

/** `true` when a path is the project or inside it, without touching the filesystem. */
export function insideProject(directory: string, path: string): boolean {
  const project = normalize(isAbsolute(directory) ? directory : resolve(directory))
  return under(project, normalize(isAbsolute(path) ? path : resolve(project, path)))
}

async function sizeRefusal(bytes: number, maxBytes: number): Promise<never> {
  throw new ColabError("FILE_TOO_LARGE", `The file is ${bytes} bytes, over the plugin's ${maxBytes}-byte cap.`, {
    next: "Raise maxDownloadBytes for this plugin, or split the notebook.",
  })
}

/** Reads a local file, refusing one over the cap before it is read into memory. */
export async function readWorkspaceFile(target: WorkspaceTarget, maxBytes: number): Promise<Uint8Array> {
  let size: number
  try {
    const info = await stat(target.absolute)
    if (info.isDirectory()) refused("The path is a folder, not a notebook.")
    size = info.size
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ColabError("NOT_FOUND", `There is no file at "${redact(target.relative)}".`, { next: "colab_find lists the workspace's notebooks." })
    throw error
  }
  if (size > maxBytes) await sizeRefusal(size, maxBytes)
  return readFile(target.absolute)
}

/** Reads a local file as text, for a sync record or an existing destination. */
export async function readOptionalFile(target: WorkspaceTarget): Promise<Uint8Array | undefined> {
  try {
    return await readFile(target.absolute)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
}

export async function exists(target: WorkspaceTarget): Promise<boolean> {
  try {
    await lstat(target.absolute)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/** A file exists at the target and `overwrite` was not given. */
export function refuseExisting(target: WorkspaceTarget, next = "Pass overwrite: true after the person agrees, or choose another path."): never {
  throw new ColabError("FILE_EXISTS", `A file already exists at "${redact(target.relative)}".`, { next })
}

/**
 * Writes bytes atomically: a temp file in the destination's folder, then a rename. The folder is created when it is
 * missing (a `create` edit), and the mode is 0644 so the umask cannot make a notebook unreadable.
 */
export async function writeWorkspaceFile(target: WorkspaceTarget, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(target.absolute), { recursive: true })
  const temporary = `${target.absolute}.${randomBytes(6).toString("hex")}.tmp`
  // A rewrite keeps the file's own mode; a new file gets 0644, so the umask cannot make it unreadable.
  const mode = await lstat(target.absolute).then((info) => info.mode & 0o777, () => 0o644)
  try {
    await writeFile(temporary, bytes, { mode })
    await rename(temporary, target.absolute)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

/** The workDir, as an absolute path inside the project. */
export function workDirectory(directory: string, workDir: string): string {
  const project = normalize(isAbsolute(directory) ? directory : resolve(directory))
  return normalize(isAbsolute(workDir) ? workDir : resolve(project, workDir))
}
