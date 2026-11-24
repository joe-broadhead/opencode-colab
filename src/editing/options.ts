import * as z from "zod"
import { ACCESS_VALUES } from "../constants.js"
import { ColabError } from "../domain/errors.js"
import { redact } from "../redact.js"

const Bytes = z.union([
  z.number().int().positive(),
  z.string().regex(/^\d+(?:KiB|MiB|GiB)$/).transform((text) => {
    const [, count, unit] = /^(\d+)(KiB|MiB|GiB)$/.exec(text)!
    return Number(count) * { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit as "KiB" | "MiB" | "GiB"]
  }).pipe(z.number().int().positive()),
])

const schema = z.strictObject({
  access: z.enum(ACCESS_VALUES).default("all"),
  maxInlineBytes: Bytes.default(32 * 1024),
  maxDownloadBytes: Bytes.default(2 * 1024 ** 3),
  allowedRoots: z.array(z.string().min(1).regex(/^[^:\\\u0000-\u001f\u007f]+$/).refine((path) => !path.split("/").includes(".."))).default([]),
  allowUntestedHost: z.boolean().default(false),
})

export type EditingOptions = z.output<typeof schema>

export function loadEditingOptions(raw: unknown): EditingOptions {
  const parsed = schema.safeParse(raw === undefined ? {} : raw)
  if (parsed.success) return parsed.data
  const issue = parsed.error.issues[0]
  const key = issue?.code === "unrecognized_keys" ? issue.keys[0] : issue?.path.join(".")
  const label = key === undefined || key === "" ? "Plugin options" : `Plugin option "${redact(key)}"`
  throw new ColabError("OPTIONS_INVALID", `${label} is not valid for this editing-only build.`, {
    next: issue?.code === "unrecognized_keys" ? `Remove the unsupported option "${redact(key ?? "")}" from opencode.json.` : "Check the local plugin options in opencode.json.",
  })
}
