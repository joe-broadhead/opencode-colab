/**
 * Local paths for package E's writes: resolve a workspace path inside the project (or an allowed root), refuse a path
 * that escapes or is a symlink, and write copy-on-write without ever replacing an existing file (design §6: read tools
 * write only new files inside `workDir`, never over an existing path).
 *
 * `PATH_REFUSED` and `FILE_EXISTS` are the family's codes for those two refusals. This is E's own small helper: package C
 * owns the notebook paths and package D the download destinations, and no shared path port exists yet (a contract
 * request names one).
 */
import { randomBytes } from "node:crypto"
import { readFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { ColabError } from "../domain/errors.js"

const inside = (root: string, target: string) => {
  const path = relative(root, target)
  return path === "" || (!path.startsWith("..") && !isAbsolute(path))
}

function realOrSelf(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** Every existing component between `root` and `target` must not be a symlink. */
function refuseSymlinks(root: string, target: string): void {
  let current = root
  for (const segment of relative(root, target).split(/[\\/]/).filter(Boolean)) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new ColabError("PATH_REFUSED", "The path goes through a symlink.", { next: "Use a real path inside the project." })
    } catch (error) {
      if (error instanceof ColabError) throw error
      return
    }
  }
}

/**
 * A workspace path as an absolute one inside the project or one of `allowedRoots`; a relative path resolves against the
 * project. A symlink on the way, or a path outside every root, answers `PATH_REFUSED`.
 */
export function resolveLocal(directory: string, path: string, allowedRoots: readonly string[] = []): string {
  const project = realOrSelf(directory)
  const target = resolve(isAbsolute(path) ? path : join(project, path))
  const roots = [project, ...allowedRoots.map((root) => realOrSelf(isAbsolute(root) ? root : join(project, root)))]
  const root = roots.find((candidate) => inside(candidate, target))
  if (!root) throw new ColabError("PATH_REFUSED", "The path is outside the project and its allowed roots.", { next: "Use a path inside the project; the person may add an allowed root." })
  refuseSymlinks(root, target)
  return target
}

/** The path as the person sees it: relative to the project when inside it. */
export function projectPath(directory: string, file: string): string {
  const path = relative(realOrSelf(directory), file)
  return path.startsWith("..") ? file : path === "" ? "." : path.split(/[\\/]/).join("/")
}

/** mkdir -p, then a temp file and a rename; `overwrite: false` answers FILE_EXISTS rather than replacing a file. */
export function writeAtomic(target: string, bytes: Uint8Array, overwrite = false): void {
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  if (!overwrite && existsSync(target)) throw new ColabError("FILE_EXISTS", "The destination exists and overwrite was not set.", { next: "Pass overwrite: true after the person agrees, or choose another path." })
  const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`
  try {
    writeFileSync(temp, bytes, { mode: 0o600, flag: "wx" })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

/**
 * A plugin artifact (a run's saved notebook or output): written once, and read back when it is already there, so a
 * second poll of the same run neither fails nor replaces anything.
 */
export function writeOnce(target: string, bytes: Uint8Array): Uint8Array {
  if (existsSync(target)) return new Uint8Array(readFileSync(target))
  writeAtomic(target, bytes)
  return bytes
}
