/**
 * The plugin entry: one `register` call wires all 24 methods through the contract's doors, the accounts module holds
 * one Agent Platform MCP server per alias, and the commands and skills stay outside the manifest.
 */
import { realpath } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { assertHost, register } from "@we-the-rebel-alliance/plugin-contract/register"
import { accountsFor, registerColabAccounts } from "./accounts.js"
import { registerCommands } from "./commands.js"
import { createHandlers } from "./handlers/index.js"
import { manifest, version } from "./manifest.js"
import { loadOptions } from "./options.js"
import { createProvider } from "./provider/index.js"
import { startAutomation } from "./provider/cost/index.js"
import type { AuthHost, HostConnection, HostCredential } from "./provider/auth/host.js"
import { registerSkills } from "./skills.js"

/** The host's integration connection API, reduced to the credential store auth reads. */
function authHostOf(ctx: Plugin.Context): AuthHost {
  return {
    active: (integrationID) => ctx.integration.connection.active(integrationID) as Promise<HostConnection | undefined>,
    resolve: (connection) => ctx.integration.connection.resolve(connection as never) as Promise<HostCredential | undefined>,
    ...(ctx.integration.connection.status
      ? {
          report: async (integrationID: string, connection: HostConnection, message: string) =>
            ctx.integration.connection.status!({ integrationID, connection: connection as never, status: { status: "needs_auth", message } }),
        }
      : {}),
  }
}

export default Plugin.define({
  id: manifest.plugin.name,
  async setup(ctx) {
    assertHost(ctx, manifest)
    const rawOptions = (ctx.options ?? {}) as Readonly<Record<string, unknown>>
    const options = loadOptions(rawOptions)
    const directory = await realpath(ctx.location.directory)
    const integrationIDs = new Map<string, string>()
    const deps = createProvider({ options, directory, integrationIDs })
    const host = authHostOf(ctx)
    const problems: string[] = []
    const accounts = await registerColabAccounts(ctx, { manifest, rawOptions, options, host, integrationIDs, problems })
    const profiles = accountsFor(manifest, rawOptions)
    const handlers = createHandlers({ deps, manifest, version, hostVersion: ctx.app.version, profiles, problems })
    let registration: Awaited<ReturnType<typeof register>>
    try {
      registration = await register(ctx, manifest, handlers)
    } catch (error) {
      await accounts.detach()
      throw error
    }
    let automation: { dispose(): Promise<void> } | undefined
    try {
      automation = startAutomation(deps)
      const commands = await registerCommands(ctx, { deps, manifest, options, profiles, version, hostVersion: ctx.app.version, host })
      const skills = await registerSkills(ctx)
      return async () => {
        await automation?.dispose().catch(() => undefined)
        await commands.dispose().catch(() => undefined)
        await skills.dispose().catch(() => undefined)
        await accounts.detach()
        await registration.dispose().catch(() => undefined)
      }
    } catch (error) {
      await automation?.dispose().catch(() => undefined)
      await accounts.detach()
      await registration.dispose().catch(() => undefined)
      throw error
    }
  },
})
