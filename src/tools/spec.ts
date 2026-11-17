/**
 * The tool wrapper every handler runs inside, as the model's tool and as a tools RPC method alike, so the two cannot
 * drift: parse the input (INPUT_INVALID), resolve the account, assert `colab.<tool>` on the tool's resources with the
 * handler's ask metadata, then run the handler. A ColabError becomes a result with `state`, `error`, `message` and
 * `next` (design §6, §12); a stopped call becomes CANCELLED; a permission denial from the host propagates unchanged.
 *
 * Asserted equals declared: the wrapper asserts exactly `actionOf(name)`; colab_write and colab_delete assert
 * `colab.write` / `colab.delete` on their plan's resource in src/plans/route.ts; handlers add only `colab.read`.
 */
import type { JsonSchema, MethodClass, PluginMethod } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import * as z from "zod"
import { NAMESPACE } from "../constants.js"
import { actionOf, operationResource, READ_ACTION, toolEntry } from "../domain/actions.js"
import { CONTRACTS, type Failure, type ToolName } from "../domain/contract.js"
import { ColabError } from "../domain/errors.js"
import type { Deps } from "../deps.js"
import { resolveAccount } from "../options.js"
import type { Assert, PermissionRequest } from "../ports.js"
import { redact } from "../redact.js"
import { resourcesFor } from "./resources.js"
import type { CallContext, HandlerContext, ToolCall, ToolHandler } from "./types.js"

/** What runs a tool: the ports, and the host's `permission.assert`. */
export interface Runner {
  readonly deps: Deps
  readonly assert: Assert
  readonly handler: (name: ToolName) => ToolHandler<ToolName>
}

/** The tools that assert their own action, on their plan's resource. */
export const SELF_ASSERTING: ReadonlySet<ToolName> = new Set(["write", "delete"])

export function failureOf(error: unknown): Failure | undefined {
  if (ColabError.is(error)) {
    return {
      state: error.state,
      error: error.code,
      message: error.detail,
      next: error.next,
      ...(error.reason !== undefined ? { reason: error.reason } : {}),
      ...(error.retryAfterSec !== undefined ? { retryAfterSec: error.retryAfterSec } : {}),
    }
  }
  if (error instanceof Error && error.name === "AbortError") return failureOf(new ColabError("CANCELLED"))
  return undefined
}

export function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input)
  if (result.success) return result.data
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
  throw new ColabError("INPUT_INVALID", `The input does not fit the tool's schema: ${redact(issues)}.`)
}

export function request(call: ToolCall, action: string, resources: readonly string[], metadata: Readonly<Record<string, unknown>>, save: boolean): PermissionRequest {
  return {
    sessionID: call.sessionID,
    agent: call.agent,
    action,
    resources: [...resources],
    ...(save ? { save: [...resources] } : {}),
    metadata,
    source: { type: "tool", messageID: call.messageID, id: call.id },
  }
}

/** OpenCode's own permissions a handler may assert through `hostAssert`. */
export const HOST_ACTIONS: ReadonlySet<string> = new Set(["edit", "external_directory", "read"])

/** A handler context for one call on one account: `providerRead` asserts `colab.read` once per operation. */
export function handlerContext(runner: Runner, call: ToolCall, account: HandlerContext["account"]): HandlerContext {
  const asserted = new Set<string>()
  return {
    call,
    account,
    deps: runner.deps,
    async providerRead(operation) {
      const resource = operationResource(account.alias, operation)
      if (asserted.has(resource)) return
      await runner.assert(request(call, READ_ACTION, [resource], { account: account.alias, operation }, true))
      asserted.add(resource)
    },
    async hostAssert(host) {
      if (!HOST_ACTIONS.has(host.action)) throw new Error(`hostAssert takes only OpenCode's host actions, not ${String(host.action)}`)
      await runner.assert({
        sessionID: call.sessionID,
        agent: call.agent,
        action: host.action,
        resources: [...host.resources],
        ...(host.save ? { save: [...host.save] } : {}),
        metadata: host.metadata,
        source: { type: "tool", messageID: call.messageID, id: call.id },
      })
    },
  }
}

/**
 * An account with `access: "read"` makes no change (design §4): every change tool, colab_plan, and every plan commit
 * refuse it here, before any assert or network call. Scopes cannot do this for Enterprise (cloud-platform has no read
 * form), Drive (drive.file at both levels) or runs (the proxy token comes with colaboratory.readonly).
 */
export function assertWritable(account: Pick<HandlerContext["account"], "alias" | "access">): void {
  if (account.access !== "read") return
  throw new ColabError("ACCOUNT_READ_ONLY", `The account "${account.alias}" has access read, so the plugin makes no change on it.`, {
    next: `Set accounts.${account.alias}.access to write and sign in again.`,
  })
}

/** The tools refused on a read account: the eight changes, and colab_plan, whose only purpose is a change. */
export const needsWrite = (name: ToolName) => name === "plan" || toolEntry(name).class !== "read"

/** Runs one tool call: the same path for the model's tool and a script's RPC method. */
export async function runTool(name: ToolName, raw: unknown, call: ToolCall, runner: Runner): Promise<unknown> {
  try {
    const input = parse(CONTRACTS[name].input, raw) as Record<string, unknown>
    const handler = runner.handler(name)
    if (SELF_ASSERTING.has(name)) {
      // colab_write / colab_delete: no account is resolved here, because the plan names it; the route builds the
      // handler context from plan.account and asserts on the plan's resource.
      const base: CallContext = { call, deps: runner.deps }
      return await handler.run(input as never, base as HandlerContext)
    }
    const account = resolveAccount(runner.deps.options, typeof input.account === "string" ? input.account : undefined)
    if (needsWrite(name)) assertWritable(account)
    const ctx = handlerContext(runner, call, account)
    const resources = await resourcesFor(name, input, account.alias, runner.deps.ledger)
    const metadata = { account: account.alias, ...(await handler.metadata?.(input as never, ctx)) }
    // colab_run asserts once per call (actions.ts, runResources): the probe and watchdog run under this one assert.
    await runner.assert(request(call, actionOf(name), resources, metadata, true))
    return await handler.run(input as never, ctx)
  } catch (error) {
    const failure = failureOf(error)
    if (failure) return failure
    throw error
  }
}

/** Compact JSON for a direct call, cut at the inline cap with a note. */
export function render(output: unknown, maxBytes: number): { text: string; truncated: boolean } {
  const text = JSON.stringify(output) ?? ""
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { text, truncated: false }
  const cut = Buffer.from(text).subarray(0, maxBytes).toString("utf8")
  return { text: `${cut}\n…[truncated: ${maxBytes} of ${bytes} bytes shown; page with next, or read the run's files]`, truncated: true }
}

/** A tool as the host registers it, for `ctx.tool.transform`'s `editor.add`. */
export function buildTool(name: ToolName, runner: Runner) {
  const entry = toolEntry(name)
  return {
    /** The host prefixes the namespace: the model sees `colab_<name>`. */
    name,
    description: CONTRACTS[name].description,
    input: CONTRACTS[name].input,
    output: CONTRACTS[name].output,
    options: { namespace: NAMESPACE, permission: actionOf(name), codemode: entry.codemode },
    execute: async (raw: unknown, context: ToolCall) => {
      const output = await runTool(name, raw, context, runner)
      const rendered = render(output, runner.deps.options.maxInlineBytes)
      const code = (output as { error?: string } | undefined)?.error
      return { output, content: rendered.text, metadata: { tool: actionOf(name), ...(code ? { code } : {}), ...(rendered.truncated ? { truncated: true } : {}) } }
    },
  }
}

const methodClass = (name: ToolName): MethodClass => {
  const cls = toolEntry(name).class
  return cls === "read" ? "read" : cls
}

/** A read tool as a tools RPC method (D18: changes are never RPC methods). */
export function scriptMethod(name: ToolName, runner: Runner): PluginMethod {
  if (toolEntry(name).class !== "read") throw new Error(`${name} is a change and never a tools RPC method`)
  return {
    kind: "plugin",
    name,
    action: actionOf(name),
    class: methodClass(name),
    description: CONTRACTS[name].description,
    input: schemaOf(CONTRACTS[name].input, "input"),
    output: schemaOf(CONTRACTS[name].output, "output"),
    run: (input, call) => runTool(name, input, call, runner),
  }
}

function schemaOf(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  try {
    return z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema
  } catch {
    return { type: "object" }
  }
}
