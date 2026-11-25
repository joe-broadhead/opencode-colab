/**
 * The provider-backed methods: one handler entry per method, wrapping the package handler that owns its work.
 *
 * The contract's register owns input and output checks, account resolution, permissions and the doors; this file only
 * re-parses the input with the package's zod schema (so defaults and transforms apply), builds the provider context, and
 * refuses a change on a read account.
 */
import * as z from "zod"
import { refusal, RegisterError, type MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import * as cost from "../provider/cost/index.js"
import * as enterprise from "../provider/enterprise/index.js"
import * as execution from "../provider/execution/index.js"
import * as notebooks from "../provider/notebooks/index.js"
import { CONTRACTS, type ToolName } from "../domain/contract.js"
import type { Deps } from "../provider/index.js"
import type { ToolHandler } from "../provider/types.js"
import { emitChanged } from "./changed.js"
import { assertWritable, providerAccount, providerContext } from "./context.js"
import { mapped } from "./errors.js"

const PACKAGE_HANDLERS = {
  ...notebooks.HANDLERS,
  ...execution.HANDLERS,
  ...enterprise.HANDLERS,
} as Readonly<Record<string, ToolHandler<ToolName> | undefined>>

/** Methods whose provider handler changes something (the account's access must be write). */
const WRITES: ReadonlySet<string> = new Set(["edit", "run", "cancel", "upload", "download", "pause"])

function schema(schema: z.ZodType, io: "input" | "output"): Record<string, unknown> {
  try {
    const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as Record<string, unknown>
    if (io === "input") {
      // The register adds the account selector; a handler's own schema must not declare it.
      const properties = json["properties"] !== null && typeof json["properties"] === "object" ? { ...(json["properties"] as Record<string, unknown>) } : undefined
      if (properties !== undefined) {
        delete properties["account"]
        const required = Array.isArray(json["required"]) ? (json["required"] as unknown[]).filter((key) => key !== "account") : []
        return { ...json, properties, ...(required.length === 0 ? { required: undefined } : { required }) }
      }
    }
    return json
  } catch {
    return { type: "object", additionalProperties: true }
  }
}

/** Re-parse with the package's schema, with the register's account put back so defaults and the account field apply. */
function parse(name: string, schema: z.ZodType, input: unknown, account: string): unknown {
  const parsed = schema.safeParse({ ...(input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {}), account })
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")
  throw new RegisterError(refusal("INPUT_INVALID", `${name}'s input breaks its schema: ${problems}`, "Pass only the input the method's schema describes."))
}

/** One entry per provider-backed method. `usage` reuses the rich status read, which is no longer `status`. */
export function providerHandlers(deps: Deps): Record<string, MethodHandler> {
  const entries: Record<string, MethodHandler> = {}
  const names = [...Object.keys(PACKAGE_HANDLERS), "usage"] as const
  for (const name of names) {
    const contract = CONTRACTS[name === "usage" ? "status" : (name as ToolName)]
    const handler = name === "usage" ? cost.HANDLERS.status : PACKAGE_HANDLERS[name]
    if (handler === undefined || contract === undefined) continue
    entries[name] = {
      description: contract.description,
      input: schema(contract.input, "input"),
      output: schema(contract.output, "output"),
      async run(input, call) {
        return mapped(async () => {
          const account = providerAccount(deps, call.account)
          const parsed = parse(name, contract.input, input, account.alias)
          if (WRITES.has(name)) assertWritable(account)
          const ctx = providerContext(deps, account, call)
          const result = await handler.run(parsed as never, ctx as never)
          // Contract §4.7: every successful non-read method nudges the area it changed.
          if (WRITES.has(name)) await emitChanged(call, account.alias, name)
          return result
        })
      },
    }
  }
  return entries
}
