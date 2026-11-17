// The server part: the default rules, the `colab` namespace and its twenty tools, status, the tools RPC for scripts,
// the skills, and each package's own host registrations (auth, cost), in the family's setup order. Everything goes
// through public OpenCode plugin APIs. Every transform is synchronous and never throws: a failure is kept and shown
// by status.
import { Plugin } from "@opencode/plugin"
import { registerToolsRpc } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { registerAuth } from "./auth/index.js"
import { PLUGIN_ID } from "./constants.js"
import { registerCost } from "./cost/index.js"
import { createDeps, type Deps } from "./deps.js"
import { TOOLS } from "./domain/actions.js"
import type { ToolName } from "./domain/contract.js"
import { checkHost } from "./host-version.js"
import { loadOptions } from "./options.js"
import { registerPermissionDefaults } from "./permissions.js"
import { registerSkills, SKILL_IDS, skillPath } from "./skills.js"
import { registerStatus } from "./status.js"
import { registerTools } from "./tools.js"
import { toolHandlers } from "./tools/registry.js"
import type { Runner } from "./tools/spec.js"
import { methods, PLUGIN } from "./tools-rpc.js"

type Registration = { dispose(): Promise<void> }

/** Internal seam: tests replace the ports (test/fakes) without touching the host wiring. */
export interface ColabSeam {
  readonly deps?: (base: Deps) => Deps
}

export function createColabPlugin(seam: ColabSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = loadOptions(ctx.options)
      const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
      const base = createDeps({ options, directory: ctx.location.directory })
      const deps = seam.deps ? seam.deps(base) : base
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
      let runner: Runner | undefined
      const getRunner = (): Runner => {
        runner ??= (() => {
          const handlers = toolHandlers(getRunner)
          return { deps, assert: (request) => ctx.permission.assert(request as never), handler: (name: ToolName) => handlers[name] }
        })()
        return runner
      }
      try {
        keep(await registerPermissionDefaults(ctx, options.access, report("rules")))
        keep(await registerTools(ctx, { access: options.access, runner: getRunner, report: report("tools") }))
        keep(await registerAuth(ctx, { options, clock: deps.clock }))
        keep(
          await registerStatus(ctx, {
            access: options.access,
            accounts: options.accounts.map((account) => ({ alias: account.alias, backend: account.backend })),
            tools: () => ({ registered: problems.has("tools") ? 0 : TOOLS.length }),
            hostVersion: ctx.app.version,
            ...(hostWarning ? { hostWarning } : {}),
            skills: SKILL_IDS.map((id) => ({ id, path: skillPath(id) })),
            problems: () => [...problems.values()],
          }),
        )
        // Scripts call the read tools with no model, as a session and its agent: only a prior allow runs.
        const stopTools = await registerToolsRpc(ctx as never, { plugin: PLUGIN, methods: methods(getRunner()) })
        keep({ dispose: stopTools })
        keep(await registerSkills(ctx))
        keep(await registerCost(ctx, deps))
      } catch (error) {
        await cleanup().catch(() => undefined)
        throw error
      }
      return cleanup
    },
  })
}
