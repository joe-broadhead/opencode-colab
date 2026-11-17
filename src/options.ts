// Plugin options. Strict: an option that is not listed here is refused with OPTIONS_INVALID rather than ignored, so a
// typo cannot silently leave the plugin more open than the person meant. Every option is optional.
import * as z from "zod"
import { ACCESS_VALUES } from "./constants.js"
import { ColabError } from "./domain/errors.js"

const OptionsSchema = z.strictObject({
  access: z.enum(ACCESS_VALUES).default("all"),
  allowUntestedHost: z.boolean().default(false),
})

export type Options = z.output<typeof OptionsSchema>

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-colab#v0.0.1", "options": { "access": "ask-changes" } }]`

export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {})
  if (result.success) return result.data
  const issue = result.error.issues[0]
  const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".")
  const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value")
  throw new ColabError("OPTIONS_INVALID", path ? `Invalid plugin option "${path}": ${message}.` : `Invalid plugin options: ${message}.`, {
    next: `Fix the plugin's options in opencode.json, for example ${EXAMPLE}.`,
  })
}
