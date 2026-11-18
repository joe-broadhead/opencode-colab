/**
 * The `colab.runtimes` source (design §11): a snapshot of the account's runtimes as a `list` (source-contract's
 * `output.list`: at most 50 items of `{ id, text ≤ 200, note? ≤ 200 }`), so a consumer can show what is running and
 * what costs money. Free: one listing call to Google per read, asserted as `colab.read` on its operation.
 *
 * - **Colab** (consumer): `runtimes.list` names every runtime assigned to the person, not only the plugin's own
 *   (Colab API v1beta, `runtimes.list`, discovery revision 20261115). The ledger tells which are the plugin's own and
 *   which are tainted; a runtime the person opened elsewhere is listed and marked "not the plugin's". Google publishes
 *   no per-accelerator compute-unit rate, so no item carries a price (design §8.1).
 * - **Colab Enterprise**: `notebookRuntimes.list` (Vertex AI v1); each item names its machine, accelerator, state, the
 *   dated price table's USD/h when it prices that machine in the account's region, and the idle-shutdown and end-user
 *   credential flags. A stopped runtime still bills its disk, and the note says so.
 *
 * More than 50 runtimes, or a listing the client cut at its page bound, is TOO_LARGE rather than a partial list.
 */
import { SourceError } from "@we-the-rebel-alliance/source-contract/events"
import type { Deps } from "../deps.js"
import { OPERATIONS, type Operation } from "../domain/actions.js"
import type { ResolvedAccount } from "../options.js"
import type { ColabRuntime, EnterpriseRuntime, RuntimeRecord, RuntimeSpecKey } from "../ports.js"
import { asSource } from "./errors.js"
import { duration, PACKAGE } from "./runs.js"

export const RUNTIMES = "runtimes"
export const RUNTIMES_ID = "colab.runtimes"
/** The descriptor's `maxBytes` for the snapshot. */
export const RUNTIMES_MAX_BYTES = 32_768
/** `output.list`'s item bound. */
export const MAX_ITEMS = 50

export interface ListItem {
  readonly id: string
  readonly text: string
  readonly note?: string
}

export interface RuntimesSnapshot {
  readonly source: typeof RUNTIMES
  readonly account: string
  readonly data: { readonly items: readonly ListItem[]; readonly editable: false }
  readonly asOf: string
  readonly trust: "untrusted"
  readonly plugin: typeof PACKAGE
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const lastSegment = (name: string) => name.split("/").filter(Boolean).at(-1) ?? name

/** A runtime spec in words: "T4 GPU", "v5e1 TPU", "CPU", with ", high memory" when it is. */
export function specWords(spec: RuntimeSpecKey): string {
  const kind = spec.variant === "VARIANT_GPU" ? `${spec.accelerator} GPU` : spec.variant === "VARIANT_TPU" ? `${spec.accelerator} TPU` : "CPU"
  return `${kind}${spec.shape === "SHAPE_HIGHMEM" ? ", high memory" : ""}`
}

function colabItem(runtime: ColabRuntime, record: RuntimeRecord | undefined, now: number): ListItem {
  const id = cut(lastSegment(runtime.name), 128)
  if (!record) {
    return { id, text: cut(`${specWords(runtime.spec)} - not the plugin's own (opened elsewhere)`, 200), note: "The plugin never runs code on it, lists its files or releases it." }
  }
  const taint = record.tainted ? `, tainted (${record.tainted.code}): no more runs, released only by plan` : ""
  const age = duration(now - Date.parse(record.createdAt))
  const lease = `released after ${record.lease.releaseAfterIdleMinutes} min idle or ${record.lease.maxHours} h`
  return {
    id,
    text: cut(`${specWords(runtime.spec)} - the plugin's own${taint}`, 200),
    note: cut(`Created ${age} ago; ${record.tainted ? "not released automatically" : lease}. Colab publishes no compute-unit rate.`, 200),
  }
}

function enterpriseItem(runtime: EnterpriseRuntime, usdPerHour: number | undefined): ListItem {
  const machine = runtime.machineType ?? "machine not named"
  const accelerator = runtime.accelerator && runtime.accelerator !== "NONE" && !/UNSPECIFIED$/.test(runtime.accelerator) ? ` + ${runtime.accelerator}` : ""
  const price = usdPerHour === undefined ? "" : `, about $${usdPerHour.toFixed(2)}/h`
  const state = runtime.state.replace(/^NOTEBOOK_RUNTIME_STATE_|^RUNTIME_STATE_/, "")
  const flags = [
    runtime.idleShutdownMinutes === null || runtime.idleShutdownMinutes === undefined ? "idle shutdown off" : `idle shutdown after ${runtime.idleShutdownMinutes} min`,
    ...(runtime.euc ? ["end-user credentials on"] : []),
    ...(/STOPPED/.test(runtime.state) ? ["stopped: its disk still bills"] : []),
    ...(runtime.template ? [`template ${lastSegment(runtime.template)}`] : []),
  ]
  return {
    id: cut(lastSegment(runtime.name), 128),
    text: cut(`Colab Enterprise runtime, ${machine}${accelerator}, ${state}${price}`, 200),
    note: cut(`${flags.join("; ")}.`, 200),
  }
}

function tooLarge(count: number | undefined): SourceError {
  return new SourceError({
    code: "TOO_LARGE",
    what: count === undefined ? "Google's runtime listing was cut at its page bound, so the snapshot would be partial" : `The account has ${count} runtimes, over the ${MAX_ITEMS} the snapshot lists`,
    next: "Run /colab-status or colab_runtimes to see them, and release or stop the ones you do not need.",
  })
}

/** The snapshot for one account. `read` asserts `colab.read` on the listing operation before Google is called. */
export async function readRuntimes(deps: Pick<Deps, "colab" | "vertex" | "ledger" | "prices" | "clock">, account: ResolvedAccount, read: (operation: Operation) => Promise<void>, signal: AbortSignal): Promise<RuntimesSnapshot> {
  const now = deps.clock.now().getTime()
  let items: ListItem[]
  if (account.backend === "enterprise") {
    await read(OPERATIONS.notebookRuntimesList)
    const listed = await asSource(() => deps.vertex.listRuntimes(account.alias, signal))
    if (listed.truncated) throw tooLarge(undefined)
    if (listed.length > MAX_ITEMS) throw tooLarge(listed.length)
    items = listed.map((runtime) =>
      enterpriseItem(runtime, runtime.machineType ? deps.prices.usdPerHour({ machine: runtime.machineType, ...(runtime.accelerator ? { accelerator: runtime.accelerator } : {}), ...(account.region ? { region: account.region } : {}) }) : undefined),
    )
  } else {
    await read(OPERATIONS.runtimesList)
    const listed = await asSource(() => deps.colab.listRuntimes(account.alias, signal))
    if (listed.length > MAX_ITEMS) throw tooLarge(listed.length)
    const ours = new Map((await asSource(() => deps.ledger.listRuntimes({ account: account.alias }))).map((record) => [record.id, record]))
    items = listed
      .map((runtime) => ({ runtime, record: ours.get(lastSegment(runtime.name)) }))
      .sort((a, b) => Number(!a.record) - Number(!b.record) || lastSegment(a.runtime.name).localeCompare(lastSegment(b.runtime.name)))
      .map(({ runtime, record }) => colabItem(runtime, record, now))
  }
  const snapshot: RuntimesSnapshot = { source: RUNTIMES, account: account.alias, data: { items, editable: false }, asOf: new Date(now).toISOString(), trust: "untrusted", plugin: PACKAGE }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > RUNTIMES_MAX_BYTES) throw tooLarge(items.length)
  return snapshot
}
