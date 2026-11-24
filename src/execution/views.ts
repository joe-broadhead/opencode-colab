/**
 * The read side of package D (design §6): `colab_specs`, `colab_runtimes` and `colab_files`.
 *
 * Each provider read asserts `colab.read` on its operation before the call (design §10), and the tool's own
 * `colab.specs` / `colab.runtimes` / `colab.files` was asserted by the wrapper on `<account>`. Reads never fail because
 * one optional read failed: the Jupyter idle figures on the plugin's own runtimes are best effort, so a runtimes list
 * still answers when a runtime's kernel API is down (it says the idle state is unknown).
 */
import { OPERATIONS } from "../domain/actions.js"
import type { InputOf } from "../domain/contract.js"
import { ColabError } from "../domain/errors.js"
import type { Prices, RuntimeRecord, RuntimeSpecKey } from "../ports.js"
import type { HandlerContext, ToolHandler } from "../tools/types.js"
import { bareRuntimeId, kept, oursById } from "./support.js"

/** The runtime spec as the design writes it: `CPU/standard`, `T4/standard`, `A100/highmem`. */
export function specLabel(spec: RuntimeSpecKey): string {
  const shape = spec.shape.replace("SHAPE_", "").toLowerCase()
  return spec.variant === "VARIANT_CPU" ? `CPU/${shape}` : `${spec.accelerator}/${shape}`
}

/** The accelerator verdict for a spec against the `accelerators` option (design §8.6). */
const allowed = (spec: RuntimeSpecKey, ctx: HandlerContext) => ctx.deps.options.accelerators.some((entry) => entry.toUpperCase() === spec.accelerator.toUpperCase())

/** How many runtimes of ours are running, and the ones a call could reuse (RUNTIME_CAP's next names the first). */
export async function oursRunning(account: string, ledger: Pick<HandlerContext["deps"]["ledger"], "listRuntimes">): Promise<RuntimeRecord[]> {
  return [...(await ledger.listRuntimes({ account, live: true }))].filter((record) => record.state === "ready" || record.state === "creating")
}

/** A runtime's idle state from Jupyter: every kernel idle, the newest activity, and how many sessions there are. */
export async function idleOf(record: RuntimeRecord, ctx: HandlerContext): Promise<{ readonly idle: boolean; readonly since?: string; readonly sessions: number } | undefined> {
  if (record.state !== "ready") return undefined
  try {
    const [kernels, sessions] = await Promise.all([
      ctx.deps.runtime.kernels({ account: record.account, runtimeId: record.id }, ctx.call.signal),
      ctx.deps.runtime.sessions({ account: record.account, runtimeId: record.id }, ctx.call.signal),
    ])
    const busy = kernels.some((kernel) => kernel.executionState !== "idle")
    const since = kernels
      .map((kernel) => kernel.lastActivity)
      .filter(Boolean)
      .sort()
      .at(-1)
    return { idle: !busy, ...(since ? { since } : {}), sessions: sessions.length }
  } catch {
    // A runtime whose Jupyter API cannot be read is still listed; its idle state is simply unknown.
    return undefined
  }
}

/** One runtime of ours as `colab_runtimes` shows it. */
function view(record: RuntimeRecord, input: { readonly idle?: { idle: boolean; since?: string }; readonly usdPerHour?: number }) {
  return {
    id: record.id,
    account: record.account,
    backend: "colab" as const,
    spec: specLabel(record.spec),
    state: record.state,
    ours: true,
    tainted: Boolean(record.tainted),
    createdAt: record.createdAt,
    ...(input.idle?.since ? { idleSince: input.idle.since } : {}),
    lease: { releaseAfterIdleMinutes: record.lease.releaseAfterIdleMinutes, maxHours: record.lease.maxHours },
    keep: [...record.keep],
    ...(input.usdPerHour !== undefined ? { usdPerHour: input.usdPerHour } : {}),
  }
}

const priceOf = (prices: Prices, input: { machine?: string; accelerator?: string; region?: string }) =>
  input.machine ? prices.usdPerHour({ machine: input.machine, ...(input.accelerator ? { accelerator: input.accelerator } : {}), ...(input.region ? { region: input.region } : {}) }) : undefined

/** `colab_specs`: consumer specs with the allow-list verdict, or Enterprise templates with $/h. */
export const specs: ToolHandler<"specs"> = {
  async run(_input: InputOf<"specs">, ctx) {
    if (ctx.account.backend === "enterprise") {
      await ctx.providerRead(OPERATIONS.templatesList)
      const templates = await ctx.deps.vertex.listTemplates(ctx.account.alias, ctx.call.signal)
      const machine = ctx.deps.options.enterpriseMachine
      const machineRate = priceOf(ctx.deps.prices, { machine, region: ctx.account.region })
      const rows = templates.slice(0, 100).map((template) => {
        const name = String(template.name ?? template.displayName ?? template.id ?? "template")
        const templateMachine = typeof template.machineType === "string" ? template.machineType : machine
        const accelerator = typeof template.acceleratorType === "string" ? template.acceleratorType : undefined
        const rate = priceOf(ctx.deps.prices, { machine: templateMachine, ...(accelerator ? { accelerator } : {}), region: ctx.account.region })
        return {
          template: name,
          allowed: true,
          verdict: rate === undefined ? "read-only template; not priced in the bundled table, so set rates to price it" : "read-only template; a job runs from it as it is",
          ...(rate !== undefined ? { usdPerHour: rate } : {}),
        }
      })
      return {
        state: "ok" as const,
        pricesAsOf: ctx.deps.prices.asOf,
        specs: [
          {
            allowed: true,
            verdict:
              machineRate === undefined
                ? `jobs' default compute (${machine}); not priced in the bundled table, so a job with no rates is ESTIMATE_UNKNOWN`
                : `jobs' default compute (${machine}), priced in the bundled table`,
            ...(machineRate !== undefined ? { usdPerHour: machineRate } : {}),
          },
          ...rows,
        ],
        ...(ctx.deps.prices.asOf === "" ? { warnings: ["RATES_UNKNOWN" as const] } : {}),
      }
    }
    await ctx.providerRead(OPERATIONS.runtimeSpecsList)
    await ctx.providerRead(OPERATIONS.subscriptionGet)
    const [list, tier] = await Promise.all([ctx.deps.colab.listRuntimeSpecs(ctx.account.alias, ctx.call.signal), ctx.deps.colab.getSubscription(ctx.account.alias, ctx.call.signal)])
    return {
      state: "ok" as const,
      tier,
      specs: list.slice(0, 100).map((entry) => {
        const permitted = allowed(entry.key, ctx)
        return {
          key: entry.key,
          eligible: entry.eligible,
          allowed: permitted,
          verdict: !permitted ? `not in accelerators (${ctx.deps.options.accelerators.join(", ")})` : entry.eligible ? "eligible" : "not eligible for this tier",
        }
      }),
      ...(tier === "SUBSCRIPTION_TIER_FREE" ? { warnings: ["FREE_TIER_PRIORITY" as const] } : {}),
    }
  },
}

/** `colab_runtimes`: the agent's view, the plugin's own first, with taint, idle, lease, keep and $/h where known. */
export const runtimes: ToolHandler<"runtimes"> = {
  async run(input: InputOf<"runtimes">, ctx) {
    // A consumer runtime is a colab account's record; an enterprise account has no ledger runtimes in this build.
    const records =
      ctx.account.backend === "colab"
        ? [...(await ctx.deps.ledger.listRuntimes({ account: ctx.account.alias }))].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        : []
    const selected = input.runtime === undefined ? records : records.filter((record) => record.id === input.runtime || `runtimes/${record.id}` === input.runtime)
    // The idle figures come from Jupyter, so their two operations are provider reads too.
    if (selected.some((record) => record.state === "ready")) {
      await ctx.providerRead(OPERATIONS.sessionsList)
      await ctx.providerRead(OPERATIONS.kernelsList)
    }
    const views = []
    for (const record of selected) {
      const idle = await idleOf(record, ctx)
      views.push(view(record, { ...(idle ? { idle } : {}) }))
    }
    if (ctx.account.backend === "enterprise") {
      await ctx.providerRead(OPERATIONS.notebookRuntimesList)
      const listed = await ctx.deps.vertex.listRuntimes(ctx.account.alias, ctx.call.signal)
      const rows = listed
        .filter((runtime) => input.runtime === undefined || runtime.name === input.runtime || runtime.name.endsWith(`/${input.runtime}`))
        .slice(0, 50)
        .map((runtime) => {
          const rate = priceOf(ctx.deps.prices, { machine: runtime.machineType, accelerator: runtime.accelerator, region: ctx.account.region })
          return {
            id: runtime.name,
            account: ctx.account.alias,
            backend: "enterprise" as const,
            spec: [runtime.machineType, runtime.accelerator].filter(Boolean).join(" + ") || runtime.template || "template",
            state: runtime.state,
            ours: false,
            tainted: false,
            ...(rate !== undefined ? { usdPerHour: rate } : {}),
            idleShutdownMinutes: runtime.idleShutdownMinutes ?? null,
            euc: runtime.euc ?? false,
          }
        })
      return { state: "ok" as const, runtimes: [...views, ...rows] }
    }
    await ctx.providerRead(OPERATIONS.runtimesList)
    const listed = await ctx.deps.colab.listRuntimes(ctx.account.alias, ctx.call.signal)
    const oursIds = new Set(records.map((record) => record.id))
    const others = listed
      .map((runtime) => ({ id: bareRuntimeId(runtime.name), spec: runtime.spec }))
      .filter((runtime) => !oursIds.has(runtime.id))
      .filter((runtime) => input.runtime === undefined || runtime.id === input.runtime || `runtimes/${runtime.id}` === input.runtime)
      .slice(0, 50)
      .map((runtime) => ({ id: runtime.id, account: ctx.account.alias, backend: "colab" as const, spec: specLabel(runtime.spec), state: "ready", ours: false, tainted: false }))
    const answer = [...views, ...others]
    if (input.runtime !== undefined && answer.length === 0) throw new ColabError("NOT_FOUND", "No runtime with that id is in the plugin's ledger or in the account's runtime list.")
    return { state: "ok" as const, runtimes: answer }
  },
}

/** `colab_files`: `/content` by default, only on a runtime of the plugin's own, with files outside `keep` marked. */
export const files: ToolHandler<"files"> = {
  async run(input: InputOf<"files">, ctx) {
    const found = await oursById(ctx.deps.ledger, ctx.account.alias, input.runtime)
    const path = input.path ?? "/content"
    await ctx.providerRead(OPERATIONS.contentsList)
    const entries = await ctx.deps.runtime.files.list(found.target, path, ctx.call.signal)
    if (entries === undefined) throw new ColabError("NOT_FOUND", "The runtime has no folder at that path.", { next: "List /content, then a folder it names." })
    return {
      state: "ok" as const,
      files: entries.slice(0, 500).map((entry) => ({
        path: entry.path,
        type: entry.type === "directory" ? ("directory" as const) : ("file" as const),
        ...(entry.size !== undefined ? { bytes: entry.size } : {}),
        ...(entry.lastModified !== undefined ? { modified: entry.lastModified } : {}),
        kept: entry.type === "directory" ? true : kept(entry.path, found.record.keep),
      })),
    }
  },
}
