// Package G, Sources (docs/v1-design.md, File ownership; design §11): colab_events_list (the `colab.runs` source, from
// the plugin's own ledger), colab_runtimes_read (the `colab.runtimes` snapshot), and the source contract's `probe`.
//
// What each read asserts is exactly what package.json `sources` declares (design §10, §11): the wrapper asserts the
// tool's own action (`colab.events_list`, `colab.runtimes_read`) on the account; the handler asserts `colab.read` on
// `<account>:colab.ledger.list`, or on the one listing operation the account's backend uses; the probe asserts
// `colab.probe` only, and reads no content. A refusal is the source contract's `SourceError`, thrown, so a consumer
// reads its code (src/sources/errors.ts). colab.runs is owned locally and needs no sign-in; colab.runtimes is owned
// by the signed-in Google account (src/sources/owner.ts).
import { PROBE, parseEventsListInput, parseProbeInput, probeResult, type ProbeResult } from "@we-the-rebel-alliance/source-contract/events"
import type { JsonSchema, PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { accountResource, OPERATIONS, PROBE_ACTION } from "../domain/actions.js"
import { ColabError } from "../domain/errors.js"
import { resolveAccount, type ResolvedAccount } from "../options.js"
import type { Runner } from "../tools/spec.js"
import type { ToolCall, ToolHandlers } from "../tools/types.js"
import { accountMismatch, asSource, inputInvalid, SourceError, sourceUnknown } from "./errors.js"
import { googleOwner, localOwner } from "./owner.js"
import { listRuns, RUNS, RUNS_ID } from "./runs.js"
import { readRuntimes, RUNTIMES, RUNTIMES_ID } from "./runtimes.js"

export { encodeRunsCursor, PACKAGE, RUNS, RUNS_ID } from "./runs.js"
export { RUNTIMES, RUNTIMES_ID } from "./runtimes.js"

/** The source names `events_list`, `runtimes_read` and `probe` take, as the descriptor's `input.source` gives them. */
export const SOURCE_NAMES = [RUNS, RUNTIMES] as const

/** A source named by its descriptor id (`colab.runs`) is the same source as its name (`runs`). */
const sourceName = (source: unknown) => (source === RUNS_ID ? RUNS : source === RUNTIMES_ID ? RUNTIMES : source)
const withName = (input: Readonly<Record<string, unknown>>) => (input.source === undefined ? input : { ...input, source: sourceName(input.source) })

export const HANDLERS: ToolHandlers = {
  events_list: {
    async run(input, ctx) {
      const parsed = parseEventsListInput(withName(input))
      if (!parsed.ok) throw inputInvalid("events_list", parsed.problems)
      if (parsed.value.source !== undefined && parsed.value.source !== RUNS) throw sourceUnknown(parsed.value.source, [RUNS])
      await ctx.providerRead(OPERATIONS.ledgerList)
      const page = await asSource(() => listRuns({ ledger: ctx.deps.ledger, clock: ctx.deps.clock, ledgerDays: ctx.deps.options.ledgerDays }, ctx.account.alias, localOwner(), parsed.value))
      return page as unknown as Record<string, unknown>
    },
  },
  runtimes_read: {
    async run(input, ctx) {
      const source = sourceName(input.source)
      if (source !== undefined && source !== RUNTIMES) throw sourceUnknown(String(source), [RUNTIMES])
      const snapshot = await readRuntimes(ctx.deps, ctx.account, (operation) => ctx.providerRead(operation), ctx.call.signal)
      return snapshot as unknown as Record<string, unknown>
    },
  },
}

/** The account a probe names, or ACCOUNT_MISMATCH; with several accounts and no `default`, the probe must name one. */
function probeAccount(runner: Runner, asked: string | undefined): ResolvedAccount {
  try {
    return resolveAccount(runner.deps.options, asked)
  } catch (error) {
    if (ColabError.is(error) && error.code === "ACCOUNT_REQUIRED") {
      throw new SourceError({ code: "ACCOUNT_MISMATCH", what: "Several Colab accounts are set and none is named default", next: "Call probe with the account alias the source reads." })
    }
    throw accountMismatch(asked ?? "default")
  }
}

/**
 * The source contract's probe: whose the source is (src/sources/owner.ts) and, for `runtimes`, the scopes its Google
 * sign-in holds; no content, no Google call. It asserts `colab.probe` on the account, as the tools RPC's own rule check
 * already did before dispatch.
 */
export async function probeSource(runner: Runner, input: unknown, call: ToolCall): Promise<ProbeResult> {
  const parsed = parseProbeInput(input !== null && typeof input === "object" && !Array.isArray(input) ? withName(input as Record<string, unknown>) : input)
  if (!parsed.ok) throw inputInvalid(PROBE, parsed.problems)
  const source = parsed.value.source ?? RUNS
  if (!(SOURCE_NAMES as readonly string[]).includes(source)) throw sourceUnknown(source, SOURCE_NAMES)
  const account = probeAccount(runner, parsed.value.account)
  await runner.assert({
    sessionID: call.sessionID,
    agent: call.agent,
    action: PROBE_ACTION,
    resources: [accountResource(account.alias)],
    save: [accountResource(account.alias)],
    metadata: { account: account.alias, source },
    source: { type: "tool", messageID: call.messageID, id: call.id },
  })
  if (source === RUNS) return probeResult({ source, account: account.alias, owner: localOwner() })
  const owner = await googleOwner(runner.deps, account, call.signal)
  const scopes = account.mode === "interactive" ? await asSource(() => runner.deps.auth.scopes(account.alias)) : []
  return probeResult({ source, account: account.alias, owner }, scopes.length > 0 ? { scopes: scopes.slice(0, 64) } : {})
}

const OBJECT: JsonSchema = { type: "object" }
const PROBE_INPUT: JsonSchema = {
  type: "object",
  properties: { source: { type: "string", enum: [...SOURCE_NAMES] }, account: { type: "string" } },
  additionalProperties: false,
}

/**
 * The source contract's `probe` as a tools RPC method. It needs the plugin's runner (the ports and the host's assert);
 * Day 0's src/tools-rpc.ts calls `sourceMethods()` without one until the contract request that passes it lands, and the
 * probe answers UNAVAILABLE until then rather than guessing an owner.
 */
export function sourceMethods(runner?: Runner): PluginMethod[] {
  return [
    {
      kind: "plugin",
      name: PROBE,
      action: PROBE_ACTION,
      class: "read",
      description: "Names the signed-in account for a source (runs or runtimes) and its sign-in's scopes; reads no content.",
      input: PROBE_INPUT,
      output: OBJECT,
      run: async (input, call) => {
        if (!runner) {
          throw new SourceError({ code: "UNAVAILABLE", what: "The source probe is not wired to the plugin's accounts in this build", next: "Update the plugin; until then read the sources without probe." })
        }
        return probeSource(runner, input, call as unknown as ToolCall)
      },
    },
  ]
}
