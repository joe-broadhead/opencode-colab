/**
 * Package D's workspace and runtime paths (design §6, §12 `PATH_REFUSED` / `FILE_EXISTS` / `FILE_TOO_LARGE`).
 *
 * A local path resolves inside the project or one of `allowedRoots`, never through a symbolic link; `colab_upload`
 * reads only such a path, `colab_download` writes only one, and both ask the host's own `read`/`edit` through
 * A write is a temp file plus a rename, so a failed download never leaves a
 * half-written file. A runtime path is absolute, has no `..` segment and no NUL: Jupyter's contents API treats it as a
 * server path, and the plugin refuses anything that could escape `/content` by accident.
 */
import { createHash, randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import { ColabError } from "../../domain/errors.js"
import { redact } from "../../redact.js"

export interface LocalTarget {
  /** The absolute path, normalized. */
  readonly absolute: string
  /** Relative to the project when inside it; otherwise the absolute path. */
  readonly relative: string
  readonly insideProject: boolean
}

export interface LocalOptions {
  readonly directory: string
  readonly allowedRoots: readonly string[]
}

const under = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

function refused(detail: string, next = "Use a path inside the project, or add its folder to the plugin's allowedRoots option."): never {
  throw new ColabError("PATH_REFUSED", detail, { next })
}

const projectOf = (directory: string) => normalize(isAbsolute(directory) ? directory : resolve(directory))

/** Refuses the first symbolic link on the existing part of the path, so a link cannot lead a read or write outside. */
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
export async function resolveLocal(path: string, options: LocalOptions): Promise<LocalTarget> {
  if (path.length === 0 || path.includes("\u0000")) refused("The path is empty or contains a NUL character.")
  const project = projectOf(options.directory)
  const absolute = normalize(isAbsolute(path) ? path : resolve(project, path))
  const roots = [project, ...options.allowedRoots.map((root) => normalize(isAbsolute(root) ? root : resolve(project, root)))]
  const root = roots.find((candidate) => under(candidate, absolute))
  if (root === undefined) refused(`The path "${redact(path)}" is outside the project and its allowed roots.`)
  await refuseSymlinks(root, absolute)
  return { absolute, relative: under(project, absolute) ? relative(project, absolute) : absolute, insideProject: under(project, absolute) }
}

/** True when the path is the project or inside it, without touching the filesystem. */
export function insideProject(directory: string, path: string): boolean {
  return under(projectOf(directory), normalize(isAbsolute(path) ? path : resolve(projectOf(directory), path)))
}

/** What a resolved local path is: the upload decides between one file and a folder without guessing from an error. */
export async function localKind(target: LocalTarget): Promise<"file" | "directory" | "other"> {
  const info = await lstat(target.absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new ColabError("NOT_FOUND", "The local path was not found.")
    throw error
  })
  if (info.isSymbolicLink()) refused("The path is a symbolic link.")
  if (info.isFile()) return "file"
  if (info.isDirectory()) return "directory"
  return "other"
}

/** Reads a local file, refusing one over the cap before it is read into memory. */
export async function readLocal(target: LocalTarget, maxBytes: number): Promise<Uint8Array> {
  const info = await lstat(target.absolute).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new ColabError("NOT_FOUND", "The local file was not found.")
    throw error
  })
  if (!info.isFile()) throw new ColabError("PATH_REFUSED", "The path is not a regular file.")
  if (info.size > maxBytes) throw new ColabError("FILE_TOO_LARGE", `The file is ${info.size} bytes, over the plugin's ${maxBytes}-byte cap.`, { next: "Split it, or raise maxUploadBytes." })
  return new Uint8Array(await readFile(target.absolute))
}

/** A folder upload's files, each resolved and read; symbolic links inside it are refused, never followed. */
export async function readFolder(target: LocalTarget, maxBytes: number): Promise<{ readonly path: string; readonly bytes: Uint8Array }[]> {
  const info = await lstat(target.absolute)
  if (!info.isDirectory()) throw new ColabError("PATH_REFUSED", "The path is not a directory.")
  const files: { path: string; bytes: Uint8Array }[] = []
  let total = 0
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const absolute = join(folder, entry.name)
      const child = await lstat(absolute)
      if (child.isSymbolicLink()) refused("The folder contains a symbolic link; the plugin does not follow one.")
      if (child.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!child.isFile()) refused("The folder contains something that is not a regular file.")
      if (child.size > maxBytes) throw new ColabError("FILE_TOO_LARGE", `A file in the folder is over the plugin's ${maxBytes}-byte cap.`, { next: "Split it, or raise maxUploadBytes." })
      total += child.size
      if (total > maxBytes) throw new ColabError("FILE_TOO_LARGE", `The folder is over the plugin's ${maxBytes}-byte cap.`, { next: "Upload a smaller folder, or raise maxUploadBytes." })
      files.push({ path: relative(target.absolute, absolute).split(sep).join("/"), bytes: new Uint8Array(await readFile(absolute)) })
    }
  }
  await walk(target.absolute)
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

/** Writes bytes to a path, atomically: a temp file in the same folder, then a rename. The caller owns existence checks. */
export async function writeAtomic(absolute: string, bytes: Uint8Array): Promise<void> {
  await mkdir(join(absolute, ".."), { recursive: true })
  const temp = `${absolute}.oc-tmp-${randomBytes(6).toString("hex")}`
  const handle = await open(temp, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.close()
    await rename(temp, absolute)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

export interface StreamedFile {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
}

/**
 * Streams a runtime file to a temp file beside the destination, hashing as it goes, then renames it into place. A
 * failure leaves no destination file and removes the temp file. `overwrite` decides only the rename's target.
 */
export async function writeStream(absolute: string, chunks: AsyncIterable<Uint8Array>, input: { readonly maxBytes: number; readonly overwrite: boolean }): Promise<StreamedFile> {
  await mkdir(join(absolute, ".."), { recursive: true })
  if (!input.overwrite && (await stat(absolute).catch(() => undefined)) !== undefined) throw new ColabError("FILE_EXISTS")
  const temp = `${absolute}.oc-tmp-${randomBytes(6).toString("hex")}`
  const handle = await open(temp, "wx", 0o600)
  const hash = createHash("sha256")
  let bytes = 0
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength
      if (bytes > input.maxBytes) throw new ColabError("FILE_TOO_LARGE", `The file is over the plugin's ${input.maxBytes}-byte cap.`, { next: "Raise maxDownloadBytes, or download part of it with a range." })
      hash.update(chunk)
      await handle.write(chunk)
    }
    await handle.close()
    await rename(temp, absolute)
  } catch (error) {
    await handle.close().catch(() => undefined)
    await unlink(temp).catch(() => undefined)
    throw error
  }
  return { path: absolute, bytes, sha256: hash.digest("hex") }
}

/** A local file as an async iterable of at most `slice` bytes, so a large upload is never held twice in memory. */
export async function* chunksOf(absolute: string, slice = 1024 * 1024): AsyncIterable<Uint8Array> {
  const stream = createReadStream(absolute, { highWaterMark: slice })
  for await (const chunk of stream) yield new Uint8Array(chunk as Buffer)
}

/** A runtime path: absolute, no NUL, no `.` or `..` segment, no backslash. */
export function runtimePath(path: string): string {
  if (path.length === 0 || path.includes("\u0000")) refused("The runtime path is empty or contains a NUL character.", "Use an absolute path on the runtime, such as /content/data.csv.")
  if (!path.startsWith("/")) refused("The runtime path is not absolute.", "Use an absolute path on the runtime, such as /content/data.csv.")
  if (path.includes("\\")) refused("The runtime path contains a backslash.", "Use / as the separator.")
  const segments = path.split("/")
  if (segments.some((segment) => segment === "." || segment === "..")) refused("The runtime path has a . or .. segment.", "Use a plain path, such as /content/data.csv.")
  return path
}

/** The default folder for a runtime file download: `<workDir>/files/<name>` (design §6). */
export const downloadDefault = (workDir: string, name: string) => `${workDir}/files/${name}`

/** The default runtime destination of an upload: `/content/<name>` (design §6). */
export const uploadDefault = (name: string) => `/content/${name}`

/** The base name of a local or runtime path, without a folder or a trailing separator. */
export const baseName = (path: string) => path.replace(/\/+$/, "").split(/[/\\]/).filter(Boolean).at(-1) ?? "file"
