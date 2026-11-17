// The server part: the default rules, status, the tools RPC for scripts and the skills, in the family's setup order.
// Everything goes through public OpenCode plugin APIs. Every transform is synchronous and never throws: a failure is
// kept and shown by status.
import { Plugin } from "@opencode/plugin"
import { registerToolsRpc } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { PLUGIN_ID } from "./constants.js"
import { checkHost } from "./host-version.js"
import { loadOptions } from "./options.js"
import { registerPermissionDefaults } from "./permissions.js"
import { registerSkills, SKILL_IDS, skillPath } from "./skills.js"
import { registerStatus } from "./status.js"
import { methods, PLUGIN } from "./tools-rpc.js"

type Registration = { dispose(): Promise<void> }

export function createColabPlugin() {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = loadOptions(ctx.options)
      const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
      const registrations: Registration[] = []
      const keep = <R extends Registration>(registration: R): R => {
        registrations.push(registration)
        return registration
      }
      const cleanup = async () => {
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      }
      const problems = new Map<string, string>()
      const report = (area: string) => (problem: string | undefined) => void (problem ? problems.set(area, problem) : problems.delete(area))
      try {
        keep(await registerPermissionDefaults(ctx, options.access, report("rules")))
        keep(
          await registerStatus(ctx, {
            access: options.access,
            accounts: [{ alias: "default", backend: "colab" }],
            tools: () => ({ registered: 0 }),
            hostVersion: ctx.app.version,
            ...(hostWarning ? { hostWarning } : {}),
            skills: SKILL_IDS.map((id) => ({ id, path: skillPath(id) })),
            problems: () => [...problems.values()],
          }),
        )
        const stopTools = await registerToolsRpc(ctx as never, { plugin: PLUGIN, methods: methods() })
        keep({ dispose: stopTools })
        keep(await registerSkills(ctx))
      } catch (error) {
        await cleanup().catch(() => undefined)
        throw error
      }
      return cleanup
    },
  })
}
