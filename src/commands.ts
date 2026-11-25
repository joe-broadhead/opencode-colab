/**
 * The three commands: `/colab` (status and cost), `/colab-doctor` (one small read per account) and `/colab-cleanup`
 * (release the idle runtimes of the plugin's own). Commands are outside `capabilities`; every method they need is
 * declared and gated by the contract's `access` setting as well.
 */
import type { Plugin } from "@opencode/plugin"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { DISPLAY_NAME, PLUGIN_NAME } from "./constants.js"
import type { Manifest } from "./manifest.js"
import type { Options, ResolvedAccount } from "./options.js"
import type { Deps } from "./provider/index.js"
import { DOCTOR_COMMAND, registerDoctor, type AuthEnv } from "./provider/auth/index.js"
import type { AuthHost } from "./provider/auth/host.js"
import { cleanupHandler } from "./handlers/cleanup.js"
import { providerHandlers } from "./handlers/provider.js"

const CLEANUP_COMMAND = "colab-cleanup"

type CommandContext = Pick<Plugin.Context, "command" | "permission" | "session" | "agent">

function call(sessionID: string, alias: string): MethodCall {
  return {
    sessionID,
    agent: "build",
    messageID: "command",
    id: `command_${alias}`,
    signal: new AbortController().signal,
    account: alias,
    bus: { emit: async () => ({ ok: true }) },
    access: { rules: [] },
    unguardedAgents: async () => [],
    door: "tool",
    progress: async () => undefined,
  } as unknown as MethodCall
}

function usageText(alias: string, value: Readonly<Record<string, unknown>>): string {
  const accounts = Array.isArray(value.accounts) ? (value.accounts as readonly Record<string, unknown>[]) : []
  const runtimes = Array.isArray(value.runtimes) ? value.runtimes : []
  const runs = Array.isArray(value.runs) ? value.runs : []
  const cleanup = Array.isArray(value.cleanup) ? (value.cleanup as readonly Record<string, unknown>[]) : []
  const cost = value.cost !== null && typeof value.cost === "object" ? JSON.stringify(value.cost) : "unknown"
  const errors = Array.isArray(value.lastErrors) ? value.lastErrors.map(String) : []
  const lines = [
    `${DISPLAY_NAME} status (${alias})`,
    `Accounts: ${accounts.map((account) => `${String(account.alias)} (${String(account.backend)}${account.signedIn === true ? "" : ", not signed in"})`).join(", ") || "none"}`,
    `Runtimes: ${runtimes.length}; runs in flight: ${runs.length}`,
    `Cost: ${cost}`,
    `Automation: ${String(value.automation ?? "unknown")}`,
    ...(cleanup.length > 0 ? ["Cleanup:", ...cleanup.map((entry) => `  ${String(entry.saving)} ${String(entry.call)}`)] : []),
    ...(errors.length > 0 ? ["Recent errors:", ...errors.map((error) => `  ${error}`)] : []),
  ]
  return lines.join("\n")
}

export interface CommandsInput {
  readonly deps: Deps
  readonly manifest: Manifest
  readonly options: Options
  readonly profiles: readonly ResolvedAccount[]
  readonly version: string
  readonly hostVersion: string
  readonly host: AuthHost
}

/** Register the commands, and return the dispose that removes them. */
export async function registerCommands(ctx: CommandContext, input: CommandsInput): Promise<{ dispose(): Promise<void> }> {
  const registrations: { dispose(): Promise<void> }[] = []
  const usage = providerHandlers(input.deps).usage!
  try {
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: PLUGIN_NAME,
          description: `Show ${DISPLAY_NAME}'s accounts, runtimes, cost and what to do next`,
          execute: async ({ sessionID, delivery }) => {
            const aliases = input.profiles.length > 0 ? input.profiles.map((account) => account.alias) : ["default"]
            const parts: string[] = []
            for (const alias of aliases) {
              try {
                const answer = (await usage.run({}, call(sessionID, alias))) as Readonly<Record<string, unknown>>
                parts.push(usageText(alias, answer))
              } catch (error) {
                parts.push(`${DISPLAY_NAME} status (${alias}) is unavailable: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`)
              }
            }
            await ctx.session.synthetic({ sessionID, delivery, text: parts.join("\n\n"), description: `${DISPLAY_NAME} status`, resume: false })
          },
        })
      }),
    )

    registrations.push(
      await registerDoctor(ctx, {
        options: input.options,
        clock: input.deps.clock,
        host: input.host,
      } satisfies AuthEnv),
    )

    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: CLEANUP_COMMAND,
          description: `List what ${DISPLAY_NAME} costs now and release the idle runtimes of the plugin's own`,
          execute: async ({ sessionID, delivery }) => {
            const aliases = input.profiles.length > 0 ? input.profiles.map((account) => account.alias) : ["default"]
            const lines: string[] = []
            for (const alias of aliases) {
              try {
                // The method door has the register's ask; a command has no door, so it asks here once per alias.
                if (input.options.access === "ask-changes" && input.profiles.length > 0) {
                  await ctx.permission.assert({ sessionID, action: "colab.cleanup", resources: [alias], metadata: { account: alias } } as never)
                }
                const answer = (await cleanupHandler(input.deps).run({}, call(sessionID, alias))) as Record<string, unknown>
                lines.push(`${alias}: ${String(answer.report)}\nReleased: ${(answer.released as string[]).join(", ") || "none"}.`)
              } catch (error) {
                lines.push(`${alias}: ${error instanceof Error ? error.message.split("\n", 1)[0] : String(error)}`)
              }
            }
            await ctx.session.synthetic({ sessionID, delivery, text: lines.join("\n\n"), description: `${DISPLAY_NAME} cleanup`, resume: false })
          },
        })
      }),
    )
    return {
      async dispose() {
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      },
    }
  } catch (error) {
    for (const registration of registrations.splice(0).reverse()) await registration.dispose().catch(() => undefined)
    throw error
  }
}

export { CLEANUP_COMMAND, DOCTOR_COMMAND }
