/**
 * The two contract sources: `events_list` reads `colab.runs` from the local ledger, and `runtimes_read` answers the
 * `colab.runtimes` table snapshot. Both pages carry `trust: "untrusted"`.
 */
import { EVENTS_LIST_INPUT_SCHEMA, PAGE_SCHEMA, parseEventsListInput } from "@we-the-rebel-alliance/plugin-contract/events"
import { refusal, RegisterError, type MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import type { Deps } from "../provider/index.js"
import { localOwner } from "../provider/owner.js"
import { listRuns, RUNS } from "../sources/runs.js"
import { readRuntimes, RUNTIMES } from "../sources/runtimes.js"
import { providerAccount } from "./context.js"
import { mapped } from "./errors.js"

const RUNTIMES_INPUT = {
  type: "object",
  properties: { source: { type: "string", description: "The snapshot to read: runtimes." } },
  additionalProperties: false,
}

const SNAPSHOT_OUTPUT = {
  type: "object",
  properties: {
    data: {
      type: "object",
      properties: {
        columns: { type: "array", items: { type: "object", additionalProperties: true } },
        rows: { type: "array", items: { type: "object", additionalProperties: true } },
      },
      required: ["columns", "rows"],
      additionalProperties: false,
    },
    asOf: { type: "string", minLength: 1 },
    trust: { type: "string", enum: ["untrusted"] },
  },
  required: ["data", "asOf", "trust"],
  additionalProperties: false,
}

const unknownSource = (asked: unknown, known: string): RegisterError =>
  new RegisterError(refusal("SOURCE_UNKNOWN", `Colab has no source named ${String(asked)}`, `Call it with source "${known}".`))

export function eventsListHandler(deps: Deps): MethodHandler {
  return {
    description: "List finished Colab runs and Enterprise jobs as contract events, oldest first, with a cursor bound to the account.",
    input: EVENTS_LIST_INPUT_SCHEMA,
    output: PAGE_SCHEMA,
    async run(input, call) {
      return mapped(async () => {
        const parsed = parseEventsListInput(input)
        if (!parsed.ok) throw new RegisterError(refusal("INPUT_INVALID", `events_list's input is invalid: ${parsed.problems.join("; ")}`, "Fix the input as the method's schema says, then call it again."))
        if (parsed.value.source !== undefined && parsed.value.source !== RUNS) throw unknownSource(parsed.value.source, RUNS)
        const account = providerAccount(deps, call.account)
        return listRuns({ ledger: deps.ledger, clock: deps.clock, ledgerDays: deps.options.ledgerDays }, account.alias, localOwner(), { ...parsed.value, account: account.alias })
      })
    },
  }
}

export function runtimesReadHandler(deps: Deps): MethodHandler {
  return {
    description: "Read a snapshot of the account's Colab or Enterprise runtimes as a table: spec, state, whether it is the plugin's own, taint, price and idle shutdown.",
    input: RUNTIMES_INPUT,
    output: SNAPSHOT_OUTPUT,
    async run(input, call) {
      return mapped(async () => {
        if (input.source !== undefined && input.source !== RUNTIMES) throw unknownSource(input.source, RUNTIMES)
        const account = providerAccount(deps, call.account)
        return readRuntimes(deps, account, call.signal)
      })
    },
  }
}
