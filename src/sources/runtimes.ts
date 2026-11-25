/**
 * The `colab.runtimes` snapshot: the account's runtimes as a `table` (at most 8 columns and 100 rows).
 *
 * Consumer accounts list the Colab runtimes assigned to the person, with the ledger marking the plugin's own and tainted
 * ones. Enterprise accounts list Vertex notebook runtimes with their machine, state, idle-shutdown and end-user
 * credential flags, and the dated price table's USD/h when it prices them. More than 100 rows is TOO_LARGE rather than a
 * partial snapshot.
 */
import { refusal, RegisterError } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Deps } from "../provider/index.js"
import { OPERATIONS } from "../domain/actions.js"
import type { ResolvedAccount } from "../options.js"
import type { ColabRuntime, EnterpriseRuntime, RuntimeRecord, RuntimeSpecKey } from "../provider/ports.js"

export const RUNTIMES = "runtimes"
export const RUNTIMES_ID = "colab.runtimes"
export const MAX_ROWS = 100
const MAX_COLUMNS = 8

export interface RuntimeTable {
  readonly columns: readonly { readonly key: string; readonly label: string }[]
  readonly rows: readonly Readonly<Record<string, string | number | boolean | null>>[]
}

export interface RuntimesSnapshot {
  readonly data: RuntimeTable
  readonly asOf: string
  readonly trust: "untrusted"
}

const cut = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)
const lastSegment = (name: string) => name.split("/").filter(Boolean).at(-1) ?? name

/** A runtime spec in words: "T4 GPU", "v5e1 TPU", "CPU", with ", high memory" when it is. */
export function specWords(spec: RuntimeSpecKey): string {
  const kind = spec.variant === "VARIANT_GPU" ? `${spec.accelerator} GPU` : spec.variant === "VARIANT_TPU" ? `${spec.accelerator} TPU` : "CPU"
  return `${kind}${spec.shape === "SHAPE_HIGHMEM" ? ", high memory" : ""}`
}

const COLUMNS = [
  { key: "id", label: "Runtime" },
  { key: "backend", label: "Backend" },
  { key: "spec", label: "Spec" },
  { key: "state", label: "State" },
  { key: "ours", label: "Ours" },
  { key: "tainted", label: "Tainted" },
  { key: "usdPerHour", label: "USD per hour" },
  { key: "idleShutdownMinutes", label: "Idle shutdown (min)" },
] as const

function colabRow(runtime: ColabRuntime, record: RuntimeRecord | undefined): Record<string, string | number | boolean | null> {
  return {
    id: cut(lastSegment(runtime.name), 128),
    backend: "colab",
    spec: cut(specWords(runtime.spec), 60),
    state: record ? (record.tainted ? "tainted" : record.state) : "assigned",
    ours: record !== undefined,
    tainted: record?.tainted !== undefined,
    usdPerHour: null,
    idleShutdownMinutes: null,
  }
}

function enterpriseRow(runtime: EnterpriseRuntime, usdPerHour: number | undefined): Record<string, string | number | boolean | null> {
  return {
    id: cut(lastSegment(runtime.name), 128),
    backend: "enterprise",
    spec: cut([runtime.machineType, runtime.accelerator].filter((part) => part !== undefined).join(" ") || "unknown", 60),
    state: runtime.state.replace(/^NOTEBOOK_RUNTIME_STATE_|^RUNTIME_STATE_/, ""),
    ours: false,
    tainted: false,
    usdPerHour: usdPerHour === undefined ? null : Math.round(usdPerHour * 100) / 100,
    idleShutdownMinutes: runtime.idleShutdownMinutes ?? null,
  }
}

function tooLarge(count: number): RegisterError {
  return new RegisterError(
    refusal("TOO_LARGE", `The account has ${count} runtimes, over the ${MAX_ROWS} the snapshot lists`, "Release or stop the runtimes you do not need, then read the snapshot again."),
  )
}

/** The snapshot for one account. The register asserts the declared operations; the reads only check the signal. */
export async function readRuntimes(deps: Pick<Deps, "colab" | "vertex" | "ledger" | "prices" | "clock">, account: ResolvedAccount, signal: AbortSignal): Promise<RuntimesSnapshot> {
  signal.throwIfAborted()
  const now = deps.clock.now().getTime()
  let rows: Record<string, string | number | boolean | null>[]
  if (account.backend === "enterprise") {
    const listed = await deps.vertex.listRuntimes(account.alias, signal)
    if (listed.truncated) throw tooLarge(MAX_ROWS)
    if (listed.length > MAX_ROWS) throw tooLarge(listed.length)
    rows = listed.map((runtime) =>
      enterpriseRow(runtime, runtime.machineType ? deps.prices.usdPerHour({ machine: runtime.machineType, ...(runtime.accelerator ? { accelerator: runtime.accelerator } : {}), ...(account.region ? { region: account.region } : {}) }) : undefined),
    )
  } else {
    const listed = await deps.colab.listRuntimes(account.alias, signal)
    if (listed.length > MAX_ROWS) throw tooLarge(listed.length)
    const ours = new Map((await deps.ledger.listRuntimes({ account: account.alias })).map((record) => [record.id, record]))
    rows = listed
      .map((runtime) => colabRow(runtime, ours.get(lastSegment(runtime.name))))
      .sort((a, b) => Number(a.ours === false) - Number(b.ours === false) || String(a.id).localeCompare(String(b.id)))
  }
  return { data: { columns: COLUMNS.slice(0, MAX_COLUMNS).map((column) => ({ ...column })), rows }, asOf: new Date(now).toISOString(), trust: "untrusted" }
}
