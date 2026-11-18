/**
 * `colab_upload` (design §6, §7.5): a workspace file or folder to a runtime **of the plugin's own**, `/content/<name>`
 * by default. Asserted by the wrapper as `colab.upload` on `jupyter.contents.save` and `runtime:<id>`; the host's own
 * `read` is asked before the file is read, and `external_directory` when the path is outside the project.
 *
 * A secret-shaped file is refused — the family's names (`.env*`, `*.pem`, `id_*`, `credentials*.json`, `.netrc`, a
 * cloud CLI config folder) and secret-shaped text (`screenSecrets`) — unless the person set `allowSecretUpload`. A
 * folder is all or nothing: every file is screened before any is written. The write is streamed to the runtime, which
 * chunks it at Jupyter's 50 MB contents limit (design §9.3; package B's transport sends the pieces).
 */
import type { InputOf } from "../domain/contract.js"
import { ColabError } from "../domain/errors.js"
import { screenSecrets } from "../redact.js"
import type { ToolHandler } from "../tools/types.js"
import { baseName, localKind, readFolder, readLocal, resolveLocal, runtimePath, uploadDefault } from "./paths.js"
import { oursById, sha256 } from "./support.js"

/** The family's secret file names (design §7.5), matched on the base name or a folder in the path. */
const SECRET_NAME = [
  /^\.env(?:$|\.)/i,
  /\.pem$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /^credentials.*\.json$/i,
  /^service[-_]?account.*\.json$/i,
  /^\.netrc$/i,
  /\.(?:p12|pfx)$/i,
  /^\.git-credentials$/i,
]
const SECRET_FOLDER = [/(?:^|\/)\.aws\//, /(?:^|\/)\.azure\//, /(?:^|\/)\.config\/gcloud\//, /(?:^|\/)\.config\/gh\//, /(?:^|\/)\.ssh\//]

export const secretName = (path: string) => SECRET_NAME.some((pattern) => pattern.test(baseName(path))) || SECRET_FOLDER.some((pattern) => pattern.test(path.replaceAll("\\", "/")))

/** True when the bytes are text enough for `screenSecrets` to mean anything: a PNG or a model's base64 must not be. */
export function isText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 8192)
  if (sample.includes(0)) return false
  let printable = 0
  for (const byte of sample) if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte < 127) || byte >= 128) printable += 1
  return sample.length === 0 || printable / sample.length > 0.95
}

/** Refuses a secret-shaped file, by name or (for text) by content, unless the person allowed it. */
export function screenUpload(path: string, bytes: Uint8Array, allow: boolean): void {
  if (allow) return
  if (secretName(path)) {
    throw new ColabError("UPLOAD_SECRET_REFUSED", "The file's name is one the plugin treats as a credential.", { next: "Don't upload it; the person may set allowSecretUpload." })
  }
  if (isText(bytes) && screenSecrets(Buffer.from(bytes).toString("utf8")).found) {
    throw new ColabError("UPLOAD_SECRET_REFUSED", "The file's text holds something secret-shaped.", { next: "Don't upload it; the person may set allowSecretUpload." })
  }
}

/** Streams bytes as the runtime's contents write expects, in 1 MiB slices. */
async function* slices(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  const size = 1024 * 1024
  for (let offset = 0; offset < bytes.byteLength; offset += size) yield bytes.subarray(offset, Math.min(offset + size, bytes.byteLength))
}

export const upload: ToolHandler<"upload"> = {
  async run(input: InputOf<"upload">, ctx) {
    const found = await oursById(ctx.deps.ledger, ctx.account.alias, input.runtime)
    const local = await resolveLocal(input.path, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
    const target = runtimePath(input.to ?? uploadDefault(baseName(input.path)))
    // The host's own read, then external_directory when the path is outside the project (design H8).
    await ctx.hostAssert({ action: "read", resources: [local.absolute], metadata: { path: local.relative } })
    if (!local.insideProject) await ctx.hostAssert({ action: "external_directory", resources: [local.absolute], metadata: { path: local.absolute } })

    const kind = await localKind(local)
    if (kind === "other") throw new ColabError("PATH_REFUSED", "The path is not a regular file or a folder.")
    if (kind === "file") {
      const bytes = await readLocal(local, ctx.deps.options.maxUploadBytes)
      screenUpload(local.absolute, bytes, ctx.deps.options.allowSecretUpload)
      const written = await ctx.deps.runtime.files.write(found.target, target, slices(bytes), ctx.call.signal)
      return { state: "ok" as const, runtime: found.record.id, to: target, bytes: written.bytes, sha256: sha256(bytes) }
    }

    // A folder: every file is screened before any is written, then each goes to <to>/<relative path>.
    const info = await readFolder(local, ctx.deps.options.maxUploadBytes)
    if (info.length === 0) throw new ColabError("INPUT_INVALID", "The folder holds no files to upload.")
    for (const file of info) screenUpload(file.path, file.bytes, ctx.deps.options.allowSecretUpload)
    let total = 0
    const manifest: string[] = []
    for (const file of info) {
      const destination = runtimePath(`${target.replace(/\/$/, "")}/${file.path}`)
      const written = await ctx.deps.runtime.files.write(found.target, destination, slices(file.bytes), ctx.call.signal)
      total += written.bytes
      manifest.push(`${file.path}:${sha256(file.bytes)}`)
    }
    return { state: "ok" as const, runtime: found.record.id, to: target, bytes: total, sha256: sha256(manifest.join("\n")) }
  },
}
