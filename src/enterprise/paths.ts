/**
 * Local paths for package E's writes: resolve a workspace path inside the project (or an allowed root), refuse a path
 * that escapes or is a symlink below its root, and write copy-on-write without ever replacing an existing file (design
 * §6: read tools write only new files inside `workDir`, never over an existing path).
 *
 * Paths are compared in their real form, because a directory may itself be behind a symlink: macOS reaches its
 * temporary directory through one, and comparing a real project with an unresolved absolute path refused every notebook
 * there (master's macOS CI). Symlinks *below* the root are still refused, as the family's
 * `PATH_REFUSED` says; a path that resolves outside the root is refused by containment even before that check.
 *
 * `PATH_REFUSED` and `FILE_EXISTS` are the family's codes for those two refusals. This is E's own small helper: package C
 * owns the notebook paths and package D the download destinations, and no shared path port exists yet (a contract
 * request names one).
 */
import { randomBytes } from "node:crypto"
import { readFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
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

/**
 * A path in its real form: every existing component's symlinks resolved, and a missing tail appended unchanged, so a
 * target inside a symlinked directory (macOS `/var`) compares equal to the real root.
 */
function realTarget(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync.native(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      tail.unshift(basename(current))
      current = parent
    }
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

/** A root as the person gave it and in its real form, so the symlink walk can use the given names. */
interface Root {
  readonly given: string
  readonly real: string
}

/**
 * A workspace path as an absolute one inside the project or one of `allowedRoots`; a relative path resolves against the
 * project. The returned path is in its real form. A symlink below the given root, or a path outside every root, answers
 * `PATH_REFUSED`.
 */
export function resolveLocal(directory: string, path: string, allowedRoots: readonly string[] = []): string {
  const projectGiven = resolve(directory)
  const roots: Root[] = [{ given: projectGiven, real: realOrSelf(projectGiven) }]
  for (const root of allowedRoots) {
    const given = resolve(isAbsolute(root) ? root : join(projectGiven, root))
    roots.push({ given, real: realOrSelf(given) })
  }
  const given = resolve(isAbsolute(path) ? path : join(projectGiven, path))
  const target = realTarget(given)
  const match = roots.find((candidate) => inside(candidate.real, target))
  if (!match) throw new ColabError("PATH_REFUSED", "The path is outside the project and its allowed roots.", { next: "Use a path inside the project; the person may add an allowed root." })
  // Refuse symlinks in the names as given, when the given path is under the given root. A path already given in real
  // form (through a resolved prefix) is guarded by containment above.
  if (inside(match.given, given)) refuseSymlinks(match.given, given)
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
