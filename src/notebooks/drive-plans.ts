/**
 * The Drive plans (design §7.2, §7.5): `drive.create`, `drive.update` and `drive.trash`, on both account backends
 * (Drive is the same API either way). Each preview is what the person reads before the commit, so it carries the facts
 * the call cannot show: the cells and hash, whether outputs are stripped (`pushOutputs`, strip by default, Q10), any
 * secret-shaped source or output **first**, the sync record's base revision against Drive's head (`DRIVE_CONFLICT` when
 * Drive moved), the keepForever note and its 200-revision cap, and — for `drive.create`/`drive.update` — that Colab's
 * autosave may overwrite a push while the notebook is open in Colab (live check L8b fixes whose write wins).
 *
 * A commit re-reads everything the preview saw and answers `PLAN_CHANGED` when the local hash, the Drive head or the
 * sync record moved. The replaced revision is pinned with `keepForever` (Drive's revisions.update; up to 200 revisions
 * per file, per the Revision resource), and when Drive refuses at the cap the result carries
 * `REVISION_PIN_SKIPPED` instead of failing a push that already landed.
 */
import { basename } from "node:path"
import { OPERATIONS } from "../domain/actions.js"
import { ColabError, type WarningCode } from "../domain/errors.js"
import type { StoredPlan } from "../ports.js"
import type { HandlerContext, PlanHandler, PlanParams, PlanPreview } from "../tools/types.js"
import { requireDrive } from "./account.js"
import { DRIVE_SIMPLE_UPLOAD_MAX } from "./drive-api.js"
import { COLAB_MIME } from "./find.js"
import {
  cellOutputs,
  cellSource,
  cellType,
  clearCellOutputs,
  hashBytes,
  notebookHash,
  parseNotebook,
  serializeNotebook,
  type Notebook,
} from "./model.js"
import { readWorkspaceFile, resolveWorkspacePath, type WorkspaceTarget } from "./paths.js"
import { readSyncRecord, writeSyncRecord } from "./sync.js"
import { screenSecrets } from "./secret.js"

type Outputs = "strip" | "keep"
type PushPlan = { readonly path: string; readonly outputs: Outputs; readonly fileId?: string }

const displayPath = (target: WorkspaceTarget) => (target.insideProject ? target.relative : target.absolute)
function planChanged(detail: string): never {
  throw new ColabError("PLAN_CHANGED", detail, { next: "Plan again and show the person the new preview." })
}

/** A name as a Drive file name: no separators or controls, `.ipynb`, at most 256 characters. */
export function pushName(requested: string | undefined, target: WorkspaceTarget): string {
  const base = (requested ?? basename(target.absolute)).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "notebook"
  const withExtension = /\.ipynb$/i.test(base) ? base : `${base}.ipynb`
  return withExtension.length <= 256 ? withExtension : `${withExtension.slice(0, 247)}.ipynb`
}

async function loadLocal(path: string, ctx: HandlerContext): Promise<{ readonly target: WorkspaceTarget; readonly notebook: Notebook; readonly hash: string }> {
  const target = await resolveWorkspacePath(path, { directory: ctx.deps.directory, allowedRoots: ctx.deps.options.allowedRoots })
  const bytes = await readWorkspaceFile(target, ctx.deps.options.maxDownloadBytes)
  return { target, notebook: parseNotebook(bytes), hash: notebookHash(bytes) }
}

/** The bytes a push uploads: the local bytes untouched when outputs are kept, otherwise the same notebook with every code cell's outputs cleared. */
function pushBytes(notebook: Notebook, outputs: Outputs): Uint8Array {
  if (outputs === "keep") return serializeNotebook(notebook)
  notebook.cells.forEach((cell, index) => {
    if (cellType(cell) === "code") clearCellOutputs(notebook, index)
  })
  // The uploaded copy keeps the file's own nbformat_minor and only the ids the file already had: a push is not an edit.
  return serializeNotebook(notebook, { persistIds: false })
}

const jsonMime = (mime: string) => mime === "application/json" || (mime.startsWith("application/") && mime.endsWith("+json"))
const textMime = (mime: string) => mime.startsWith("text/") || mime === "application/javascript" || mime === "image/svg+xml"

/** The cells whose source, or whose text output, is secret-shaped (design §7.5). Never returns the text itself. */
export function secretCells(notebook: Notebook): { readonly sources: number; readonly outputs: number } {
  let sources = 0
  let outputs = 0
  for (const cell of notebook.cells) {
    if (screenSecrets(cellSource(cell)).matches > 0) sources += 1
    if (cellType(cell) !== "code") continue
    let found = false
    for (const output of cellOutputs(cell)) {
      const pieces: string[] = []
      if (output.output_type === "stream" && typeof output.text === "string") pieces.push(output.text)
      if (output.output_type === "error") pieces.push(`${String(output.ename ?? "")}: ${String(output.evalue ?? "")}`)
      const data = output.data
      if (data !== null && typeof data === "object" && !Array.isArray(data)) {
        for (const [mime, value] of Object.entries(data)) if (typeof value === "string" && (textMime(mime) || jsonMime(mime))) pieces.push(value)
      }
      if (pieces.some((piece) => screenSecrets(piece).matches > 0)) found = true
    }
    if (found) outputs += 1
  }
  return { sources, outputs }
}

function previewWithSecrets(secret: { readonly sources: number; readonly outputs: number }, preview: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  if (secret.sources + secret.outputs === 0) return preview
  const note =
    `Secret-shaped text was found in the sources of ${secret.sources} cell(s) and the outputs of ${secret.outputs} cell(s). ` +
    "A Drive push sends the whole notebook to Google, and stripping outputs does not strip sources."
  return { secretShaped: note, cellsWithSecrets: secret, ...preview }
}

const colabAutosave = "If the notebook is open in Colab, Colab's autosave may overwrite this push."
const pinNote = "The revision this replaces is kept (keepForever). If the file already has Drive's maximum of 200 kept revisions, it is not pinned and the result says REVISION_PIN_SKIPPED."

const outputsWording = (outputs: Outputs) => (outputs === "strip" ? "outputs are stripped" : "outputs are kept")

/** The create preview: a new Drive file, so no revision is replaced. */
async function previewCreate(params: PlanParams<"drive.create">, ctx: HandlerContext): Promise<PlanPreview> {
  requireDrive(ctx.account)
  const { target, notebook, hash } = await loadLocal(params.path, ctx)
  const record = await readSyncRecord(target, ctx.deps.directory, ctx.deps.options.workDir)
  if (record) {
    throw new ColabError("FILE_EXISTS", "Drive already has a copy of this notebook, recorded by the plugin's sync record.", {
      next: "Plan drive.update to replace that Drive copy, or pull it to another path.",
    })
  }
  const outputs: Outputs = params.outputs ?? ctx.deps.options.pushOutputs
  const name = pushName(params.name, target)
  const secret = secretCells(notebook)
  const pushed = pushBytes(notebook, outputs)
  if (pushed.length > DRIVE_SIMPLE_UPLOAD_MAX) {
    throw new ColabError("FILE_TOO_LARGE", `The notebook is ${pushed.length} bytes to upload${outputs === "strip" ? " even with outputs stripped" : ""}, over Drive's 5 MB upload limit.`, {
      next: "Plan again with outputs: \"strip\", split the notebook, or push it from the Drive web app.",
    })
  }
  const preview = previewWithSecrets(secret, {
    headline: `Create ${name} in Drive with ${notebook.cells.length} cells; ${outputsWording(outputs)}.`,
    path: displayPath(target),
    name,
    ...(params.folder !== undefined ? { folder: params.folder } : {}),
    cells: notebook.cells.length,
    bytes: pushed.length,
    hash,
    outputs,
    revisions: "A new file: no revision is replaced.",
    colab: colabAutosave,
    trust: "untrusted",
  })
  return {
    preview,
    payload: { path: target.absolute, name, ...(params.folder !== undefined ? { folder: params.folder } : {}), outputs } satisfies PushPlan & { name: string; folder?: string },
    fingerprint: { hash, name, folder: params.folder ?? null, outputs },
  }
}

/** The update preview: the Drive head must still be the sync record's base, or nothing is planned. */
async function previewUpdate(params: PlanParams<"drive.update">, ctx: HandlerContext): Promise<PlanPreview> {
  requireDrive(ctx.account)
  const { target, notebook, hash } = await loadLocal(params.path, ctx)
  const record = await readSyncRecord(target, ctx.deps.directory, ctx.deps.options.workDir)
  if (!record) {
    throw new ColabError("NOT_FOUND", "No sync record says which Drive file this notebook came from.", {
      next: "Plan drive.create to push it as a new notebook, or pull the Drive copy with colab_download first.",
    })
  }
  await ctx.providerRead(OPERATIONS.driveFilesGet)
  const file = await ctx.deps.drive.get(ctx.account.alias, record.fileId, ctx.call.signal)
  if (!file) {
    throw new ColabError("DRIVE_CONFLICT", "Drive no longer has the file the sync record names.", { next: "Plan drive.create to push the notebook as a new file." })
  }
  if ((file.headRevisionId ?? "") !== record.baseRevision) {
    throw new ColabError("DRIVE_CONFLICT", "Drive's head revision differs from the sync record's base revision.", { next: "Pull the Drive copy to another path, merge, and plan again." })
  }
  const outputs: Outputs = params.outputs ?? ctx.deps.options.pushOutputs
  const secret = secretCells(notebook)
  const pushed = pushBytes(notebook, outputs)
  if (pushed.length > DRIVE_SIMPLE_UPLOAD_MAX) {
    throw new ColabError("FILE_TOO_LARGE", `The notebook is ${pushed.length} bytes to upload${outputs === "strip" ? " even with outputs stripped" : ""}, over Drive's 5 MB upload limit.`, {
      next: "Plan again with outputs: \"strip\", split the notebook, or push it from the Drive web app.",
    })
  }
  const preview = previewWithSecrets(secret, {
    headline: `Replace the Drive copy of ${file.name} with ${notebook.cells.length} cells; ${outputsWording(outputs)}.`,
    path: displayPath(target),
    drive: file.id,
    name: file.name,
    cells: notebook.cells.length,
    bytes: pushed.length,
    hash,
    outputs,
    baseRevision: record.baseRevision,
    headRevision: file.headRevisionId ?? "",
    revisions: pinNote,
    colab: colabAutosave,
    trust: "untrusted",
  })
  return {
    preview,
    payload: { path: target.absolute, outputs, fileId: file.id } satisfies PushPlan,
    fingerprint: { hash, outputs, revision: file.headRevisionId ?? "", name: file.name },
  }
}

async function previewTrash(params: PlanParams<"drive.trash">, ctx: HandlerContext): Promise<PlanPreview> {
  requireDrive(ctx.account)
  await ctx.providerRead(OPERATIONS.driveFilesGet)
  const file = await ctx.deps.drive.get(ctx.account.alias, params.drive, ctx.call.signal)
  if (!file) throw new ColabError("NOT_FOUND", "Drive has no notebook the plugin may see with that id.", { next: 'colab_find({ where: "drive" }) lists the notebooks the plugin may see.' })
  return {
    preview: {
      headline: `Move ${file.name} to the Drive trash.`,
      drive: file.id,
      name: file.name,
      ...(file.modifiedTime !== undefined ? { modified: file.modifiedTime } : {}),
      revision: file.headRevisionId ?? "",
      restorable: "A trashed notebook stays in the Drive trash until the trash is emptied, and can be restored from Drive before then. A Colab tab that has it open keeps its own copy.",
      trust: "untrusted",
    },
    payload: { drive: file.id },
    fingerprint: { name: file.name, revision: file.headRevisionId ?? "" },
  }
}

function pushPayload(plan: StoredPlan): PushPlan {
  const payload = plan.payload as unknown as PushPlan
  if (typeof payload.path !== "string" || (payload.outputs !== "strip" && payload.outputs !== "keep")) planChanged("The plan's payload is not a Drive push.")
  return payload
}

async function commitCreate(plan: StoredPlan, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>> {
  requireDrive(ctx.account)
  const payload = pushPayload(plan)
  const { target, notebook, hash } = await loadLocal(payload.path, ctx)
  if (hash !== plan.fingerprint.hash) planChanged("The local notebook changed since the preview.")
  const name = String(plan.fingerprint.name ?? pushName(undefined, target))
  const bytes = pushBytes(notebook, payload.outputs)
  await ctx.providerRead(OPERATIONS.driveFilesCreate)
  const created = await ctx.deps.drive.create(ctx.account.alias, { name, ...(typeof plan.fingerprint.folder === "string" ? { folder: plan.fingerprint.folder } : {}), bytes, mimeType: COLAB_MIME }, ctx.call.signal)
  await writeSyncRecord(target, ctx.deps.directory, ctx.deps.options.workDir, { fileId: created.id, baseRevision: created.headRevisionId ?? "", baseHash: hash })
  return { fileId: created.id, name: created.name, revision: created.headRevisionId ?? "", cells: notebook.cells.length, outputs: payload.outputs, sha256: hashBytes(bytes), trust: "untrusted" }
}

async function commitUpdate(plan: StoredPlan, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>> {
  requireDrive(ctx.account)
  const payload = pushPayload(plan)
  const { target, notebook, hash } = await loadLocal(payload.path, ctx)
  if (hash !== plan.fingerprint.hash) planChanged("The local notebook changed since the preview.")
  const record = await readSyncRecord(target, ctx.deps.directory, ctx.deps.options.workDir)
  if (!record || record.fileId !== payload.fileId) planChanged("The sync record for this notebook changed since the preview.")
  await ctx.providerRead(OPERATIONS.driveFilesGet)
  const file = await ctx.deps.drive.get(ctx.account.alias, record.fileId, ctx.call.signal)
  if (!file) planChanged("The Drive file is gone.")
  if ((file.headRevisionId ?? "") !== plan.fingerprint.revision) planChanged("Drive's head revision changed since the preview.")
  const replaced = file.headRevisionId ?? ""
  const bytes = pushBytes(notebook, payload.outputs)
  await ctx.providerRead(OPERATIONS.driveFilesUpdate)
  const updated = await ctx.deps.drive.update(ctx.account.alias, record.fileId, { bytes }, ctx.call.signal)
  let pinned = false
  if (replaced !== "") {
    await ctx.providerRead(OPERATIONS.driveRevisionsUpdate)
    pinned = await ctx.deps.drive.keepRevision(ctx.account.alias, record.fileId, replaced, ctx.call.signal)
  }
  await writeSyncRecord(target, ctx.deps.directory, ctx.deps.options.workDir, { fileId: updated.id, baseRevision: updated.headRevisionId ?? "", baseHash: hash })
  const warnings: WarningCode[] = pinned ? [] : ["REVISION_PIN_SKIPPED"]
  return {
    fileId: updated.id,
    name: updated.name,
    revision: updated.headRevisionId ?? "",
    replacedRevision: replaced,
    pinned,
    cells: notebook.cells.length,
    outputs: payload.outputs,
    sha256: hashBytes(bytes),
    ...(warnings.length > 0 ? { warnings } : {}),
    trust: "untrusted",
  }
}

async function commitTrash(plan: StoredPlan, ctx: HandlerContext): Promise<Readonly<Record<string, unknown>>> {
  requireDrive(ctx.account)
  const payload = plan.payload as unknown as { drive?: unknown }
  if (typeof payload.drive !== "string") planChanged("The plan's payload is not a Drive file id.")
  await ctx.providerRead(OPERATIONS.driveFilesGet)
  const file = await ctx.deps.drive.get(ctx.account.alias, payload.drive, ctx.call.signal)
  if (!file) planChanged("The Drive file is gone.")
  if ((file.headRevisionId ?? "") !== plan.fingerprint.revision) planChanged("The Drive file changed since the preview.")
  await ctx.providerRead(OPERATIONS.driveFilesUpdate)
  // The sync record stays: the trashed file keeps a head revision, so a later drive.update sees it moved and refuses
  // DRIVE_CONFLICT rather than pushing over a notebook the person set aside.
  await ctx.deps.drive.update(ctx.account.alias, payload.drive, { trashed: true }, ctx.call.signal)
  return { drive: payload.drive, trashed: true, trust: "untrusted" }
}

/** One handler object serves both account backends: Drive's API is the same for a Colab and an enterprise account. */
export const CREATE: PlanHandler<"drive.create"> = { preview: previewCreate, commit: commitCreate }
export const UPDATE: PlanHandler<"drive.update"> = { preview: previewUpdate, commit: commitUpdate }
export const TRASH: PlanHandler<"drive.trash"> = { preview: previewTrash, commit: commitTrash }
