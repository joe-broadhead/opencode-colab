import * as z from "zod"
import { ERROR_CODES, WARNING_CODES } from "./errors.js"

export const Hash = z.string().regex(/^sha256:[0-9a-f]{64}$/, "use the hash colab_notebook returned")

export const Warning = z.enum(WARNING_CODES as [string, ...string[]])
const Trust = z.literal("untrusted")

/** A refusal or failure: the code, what happened, and one concrete next step. */
export const Failure = z.object({
  state: z.enum(["refused", "failed"]),
  error: z.enum(ERROR_CODES as [string, ...string[]]),
  message: z.string(),
  next: z.string(),
  reason: z.string().optional(),
  retryAfterSec: z.number().nonnegative().optional(),
  warnings: z.array(Warning).optional(),
})
export type Failure = z.output<typeof Failure>

const common = { warnings: z.array(Warning).optional(), trust: Trust.optional(), next: z.string().optional(), message: z.string().optional() }

/** A tool's result: its success shape, or a Failure. */
export function result<S extends z.ZodRawShape>(shape: S, states: readonly [string, ...string[]] = ["ok"]) {
  return z.union([z.object({ state: z.enum(states), ...common, ...shape }), Failure])
}

/** Cells by nbformat id, index, or a range; ids missing in v4.0–4.4 are derived in memory and never written by reads. */
export const CellSelector = z.union([
  z.literal("all"),
  z.array(z.union([z.string().min(1), z.number().int().nonnegative()])).min(1).max(500),
  z.object({ from: z.union([z.string(), z.number().int().nonnegative()]), to: z.union([z.string(), z.number().int().nonnegative()]) }).strict(),
])

export const OutputPreview = z.object({ type: z.string(), mime: z.string().optional(), bytes: z.number().int().nonnegative(), preview: z.string().max(300).optional() })
export const CellView = z.object({
  id: z.string(),
  index: z.number().int().nonnegative(),
  type: z.enum(["code", "markdown", "raw"]),
  /** ≤ 2,000 characters, marked, secret-screened. */
  source: z.string(),
  outputs: z.array(OutputPreview),
  executionCount: z.number().int().nullable(),
})

const NewCell = z.object({ type: z.enum(["code", "markdown", "raw"]), source: z.string().max(200_000), metadata: z.record(z.string(), z.unknown()).optional() }).strict()
const CellRef = z.union([z.string().min(1), z.number().int().nonnegative()])
export const EditOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), cells: z.array(NewCell).max(500).optional(), kernel: z.string().max(64).optional() }).strict(),
  z.object({ op: z.literal("insert"), at: z.union([z.number().int().nonnegative(), z.object({ after: CellRef }).strict(), z.object({ before: CellRef }).strict()]), cell: NewCell }).strict(),
  z.object({ op: z.literal("replace"), cell: CellRef, source: z.string().max(200_000) }).strict(),
  z.object({ op: z.literal("delete"), cell: CellRef }).strict(),
  z.object({ op: z.literal("move"), cell: CellRef, to: z.number().int().nonnegative() }).strict(),
  z.object({ op: z.literal("clearOutputs"), cells: CellSelector.optional() }).strict(),
  z.object({ op: z.literal("setMetadata"), cell: CellRef.optional(), metadata: z.record(z.string(), z.unknown()) }).strict(),
])
