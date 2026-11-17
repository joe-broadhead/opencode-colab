// Plugin options (design §13). Strict: an option that is not listed here is refused with OPTIONS_INVALID rather than
// ignored, so a typo cannot silently leave the plugin more open than the person meant. Every option is optional, and
// no option holds a secret: `tokenEnv` names a variable.
import * as z from "zod"
import { ACCESS_VALUES } from "./constants.js"
import { ColabError } from "./domain/errors.js"
import type { AccountConfig } from "./ports.js"

/** "32KiB", "1MiB", "2GiB" or a number of bytes. */
const Bytes = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d+(?:KiB|MiB|GiB)$/, 'use a size such as "32KiB", "1MiB" or "2GiB"')
    .transform((text) => {
      const match = /^(\d+)(KiB|MiB|GiB)$/.exec(text)!
      return Number(match[1]) * { KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[match[2] as "KiB" | "MiB" | "GiB"]
    }),
])

const AccountSchema = z
  .strictObject({
    backend: z.enum(["colab", "enterprise"]).default("colab"),
    mode: z.enum(["interactive", "adc", "token"]).default("interactive"),
    access: z.enum(["read", "write"]).optional(),
    drive: z.boolean().optional(),
    project: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    outputBucket: z.string().regex(/^gs:\/\/[^/]+(?:\/.*)?$/, "use gs://bucket/path").optional(),
    serviceAccount: z.string().email().optional(),
    runAsUser: z.boolean().default(false),
    oauthClient: z.string().min(1).optional(),
    scopes: z.array(z.string().min(1)).optional(),
    tokenEnv: z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "name an environment variable").optional(),
    impersonate: z.string().email().optional(),
    budget: z
      .strictObject({ enterpriseUsdDaily: z.number().positive().optional(), runtimeHoursDaily: z.number().positive().optional(), action: z.enum(["warn", "refuse"]).default("warn") })
      .optional(),
  })
  .refine((account) => account.mode !== "adc" || account.backend === "enterprise", { message: "mode adc is for enterprise accounts only" })

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}$/

const OptionsSchema = z.strictObject({
  access: z.enum(ACCESS_VALUES).default("all"),
  accounts: z.record(z.string().regex(ALIAS, "use a short lowercase alias"), AccountSchema).optional(),
  oauthClient: z.string().min(1).optional(),
  redirectUri: z.string().url().optional(),
  callbackPort: z.number().int().min(1024).max(65535).optional(),
  allowAdcInHost: z.boolean().default(false),
  accelerators: z.array(z.string().min(1)).default(["NONE", "T4", "L4"]),
  maxRuntimes: z.number().int().min(1).max(10).default(1),
  keep: z.array(z.string().min(1)).default(["/content/outputs/**"]),
  autoReleaseMinutes: z.number().int().min(5).max(1440).default(20),
  maxRuntimeHours: z.number().min(0.5).max(24).default(4),
  enterpriseMachine: z.string().min(1).default("e2-standard-4"),
  jobTimeoutMinutes: z.number().int().min(1).max(1440).default(60),
  maxJobUsd: z.number().positive().default(5),
  maxJobUsdCeiling: z.number().positive().default(50),
  rates: z.record(z.string(), z.number().nonnegative()).optional(),
  automation: z.enum(["auto", "on", "off"]).default("auto"),
  maxInlineBytes: Bytes.default(32 * 1024),
  maxOutputBytesPerCell: Bytes.default(1024 * 1024),
  maxRunSeconds: z.number().int().min(60).max(86_400).default(21_600),
  maxUploadBytes: Bytes.default(512 * 1024 ** 2),
  maxDownloadBytes: Bytes.default(2 * 1024 ** 3),
  allowSecretUpload: z.boolean().default(false),
  pushOutputs: z.enum(["strip", "keep"]).default("strip"),
  workDir: z.string().min(1).default(".colab"),
  allowedRoots: z.array(z.string().min(1)).default([]),
  ledgerDays: z.number().int().min(1).max(3650).default(90),
  planTtlSeconds: z.number().int().min(30).max(3600).default(300),
  provisioningMarginMinutes: z.number().int().min(0).max(240).default(10),
  probeTimeoutSeconds: z.number().int().min(1).max(120).default(5),
  /** The probe kernel's start budget at calibration (review round 3, LOW 3); probeTimeoutSeconds bounds each probe after. */
  probeKernelStartSeconds: z.number().int().min(5).max(600).default(60),
  allowUntestedHost: z.boolean().default(false),
})

type Parsed = z.output<typeof OptionsSchema>
export type Options = Omit<Parsed, "accounts"> & { readonly accounts: readonly ResolvedAccount[] }
export type ResolvedAccount = AccountConfig & { readonly oauthClient?: string; readonly scopes?: readonly string[]; readonly budget?: NonNullable<Parsed["accounts"]>[string]["budget"] }

const EXAMPLE = `"plugins": [{ "package": "github:joe-broadhead/opencode-colab#v0.0.1", "options": { "access": "ask-changes" } }]`

/** The defaults, with no options at all: one `default` account, backend colab, interactive (design §4). */
export function loadOptions(raw: unknown): Options {
  const result = OptionsSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issue = result.error.issues[0]
    const path = issue?.code === "unrecognized_keys" ? [...issue.path, issue.keys[0]].join(".") : issue?.path.join(".")
    const message = issue?.code === "unrecognized_keys" ? "this option does not exist" : (issue?.message ?? "invalid value")
    throw new ColabError("OPTIONS_INVALID", path ? `Invalid plugin option "${path}": ${message}.` : `Invalid plugin options: ${message}.`, {
      next: `Fix the plugin's options in opencode.json, for example ${EXAMPLE}.`,
    })
  }
  const { accounts, ...rest } = result.data
  if (rest.maxJobUsd > rest.maxJobUsdCeiling) {
    throw new ColabError("OPTIONS_INVALID", `Invalid plugin option "maxJobUsd": it is over maxJobUsdCeiling (${rest.maxJobUsdCeiling}).`, { next: "Lower maxJobUsd or raise maxJobUsdCeiling." })
  }
  const entries = Object.entries(accounts ?? { default: AccountSchema.parse({}) })
  return {
    ...rest,
    accounts: entries.map(([alias, account]) => ({
      alias,
      backend: account.backend,
      mode: account.mode,
      // `write` for `default`, `read` otherwise (design §4).
      access: account.access ?? (alias === "default" ? "write" : "read"),
      drive: account.drive ?? account.backend === "colab",
      runAsUser: account.runAsUser,
      ...(account.project !== undefined ? { project: account.project } : {}),
      ...(account.region !== undefined ? { region: account.region } : {}),
      ...(account.outputBucket !== undefined ? { outputBucket: account.outputBucket } : {}),
      ...(account.serviceAccount !== undefined ? { serviceAccount: account.serviceAccount } : {}),
      ...(account.tokenEnv !== undefined ? { tokenEnv: account.tokenEnv } : {}),
      ...(account.impersonate !== undefined ? { impersonate: account.impersonate } : {}),
      ...(account.oauthClient !== undefined ? { oauthClient: account.oauthClient } : {}),
      ...(account.scopes !== undefined ? { scopes: account.scopes } : {}),
      ...(account.budget !== undefined ? { budget: account.budget } : {}),
    })),
  }
}

/** The account a call names, or the only one, or the one named `default`. */
export function resolveAccount(options: Pick<Options, "accounts">, alias: string | undefined): ResolvedAccount {
  if (alias !== undefined) {
    const found = options.accounts.find((account) => account.alias === alias)
    if (!found) throw new ColabError("ACCOUNT_UNKNOWN", `No account is named "${alias}".`)
    return found
  }
  if (options.accounts.length === 1) return options.accounts[0]!
  const fallback = options.accounts.find((account) => account.alias === "default")
  if (fallback) return fallback
  throw new ColabError("ACCOUNT_REQUIRED")
}
