/**
 * `colab_download` (design §6, §9.3): a runtime file, a Drive notebook or a GCS object into the workspace.
 *
 * A runtime file comes from a runtime **of the plugin's own**; the call asserts `colab.download` on
 * `jupyter.contents.get` and the runtime, the host's `edit` on the destination (and `external_directory` outside the
 * project), streams to a temp file, hashes as it goes, and renames — an existing path needs `overwrite`, which the
 * person agreed to. Drive is package C's `deps.driveSync.pull` and GCS is package E's `deps.enterprise.downloadGcs`;
 * both get this call's `ctx.providerRead`, so every read they make asserts `colab.read`.
 */
import { dirname, join } from "node:path"
import type { InputOf } from "../../domain/contract.js"
import { ColabError } from "../../domain/errors.js"
import type { ToolHandler } from "../types.js"
import { baseName, downloadDefault, resolveLocal, runtimePath, writeStream } from "./paths.js"
import { oursById, shownPath } from "./support.js"

/** Extensions a chart can read (`charts_quick({ data: { path } })`, design §9.3). */
const DATA = /\.(?:csv|tsv|json|jsonl|parquet)$/i

export const download: ToolHandler<"download"> = {
  async run(input: InputOf<"download">, ctx) {
    if (input.drive !== undefined || input.gcs !== undefined) {
      // The seam writes the file; the host's edit is asked on the destination, or on the folder its default is in.
      const destination = input.to ?? join(ctx.deps.options.workDir, "files")
      const local = await resolveLocal(destination, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
      const answer =
        input.drive !== undefined
          ? await ctx.deps.driveSync.pull(ctx.account.alias, { drive: input.drive, ...(input.to !== undefined ? { to: input.to } : {}), ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}) }, ctx.call.signal, ctx.providerRead)
          : await ctx.deps.enterprise.downloadGcs(ctx.account.alias, { gcs: input.gcs!, ...(input.to !== undefined ? { to: input.to } : {}), ...(input.overwrite !== undefined ? { overwrite: input.overwrite } : {}) }, ctx.call.signal, ctx.providerRead)
      return answer as never
    }

    const found = await oursById(ctx.deps.ledger, ctx.account.alias, input.runtime!)
    const path = runtimePath(input.path!)
    const destination = input.to ?? downloadDefault(ctx.deps.options.workDir, baseName(path))
    const local = await resolveLocal(destination, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
    let written: Awaited<ReturnType<typeof writeStream>>
    try {
      const chunks = await ctx.deps.runtime.files.read(found.target, path, ctx.call.signal)
      written = await writeStream(local.absolute, chunks, { maxBytes: ctx.deps.options.maxDownloadBytes, overwrite: input.overwrite === true })
    } catch (error) {
      if (error instanceof ColabError && error.code === "FILE_EXISTS") {
        throw new ColabError("FILE_EXISTS", `The destination ${local.relative} exists.`, { next: "Pass overwrite: true after the person agrees, or download to another path." })
      }
      throw error
    }
    return {
      state: "ok" as const,
      path: shownPath(written.path, ctx.deps.directory),
      bytes: written.bytes,
      sha256: written.sha256,
      ...(DATA.test(path) ? { charts: `charts_quick({ data: { path: "${shownPath(written.path, ctx.deps.directory)}" } })` } : {}),
    }
  },
}
