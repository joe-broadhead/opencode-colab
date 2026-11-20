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
import { createReleaseGate } from "./release.js"
import { registerSkills, SKILL_IDS, skillPath } from "./skills.js"
import { registerStatus } from "./status.js"
import { registerTools } from "./tools.js"
import { toolHandlers } from "./tools/registry.js"
import type { Runner } from "./tools/spec.js"
import { methods, PLUGIN } from "./tools-rpc.js"

type Registration = { dispose(): Promise<void> }

/** What `registerCost` returns: its disposal, and the hooks this host refused (design §8.4). */
export type CostRegistration = Registration & { readonly problems?: readonly string[] }

/** Internal seam: tests replace the ports (test/fakes) and package F's registration without touching the host wiring. */
export interface ColabSeam {
  readonly deps?: (base: Deps) => Deps
  readonly cost?: (ctx: never, deps: Deps) => Promise<CostRegistration>
}

/**
 * One sentence per hook package F could not register, for status's problems (design §8.4, boxd C.6). F reports a
 * hook's name (`idle` for `experimental.idle`); a full sentence passes through unchanged.
 */
export function costProblem(problem: string): string {
  if (problem === "idle" || problem === "experimental.idle") {
    return "The idle cost check is off on this OpenCode version (no `experimental.idle` hook); automation and `/colab-cleanup` still work."
  }
  if (/\s/.test(problem) && problem.endsWith(".")) return problem
  return `The ${problem} cost hook is off on this OpenCode version; automation and \`/colab-cleanup\` still work.`
}

export function createColabPlugin(seam: ColabSeam = {}) {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = loadOptions(ctx.options)
      const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
      const gate = createReleaseGate(PLUGIN_ID, () => ctx.plugin.list)
      const base = createDeps({ options, directory: ctx.location.directory, released: () => gate.released() })
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
          return { deps, released: () => gate.released(), assert: (request) => ctx.permission.assert(request as never), handler: (name: ToolName) => handlers[name] }
        })()
        return runner
      }
      try {
        keep(await registerPermissionDefaults(ctx, options.access, report("rules")))
        keep(await registerTools(ctx, { access: options.access, runner: getRunner, report: report("tools") }))
        // The doctor's print(1) needs the ledger, the agent-only check and the runtime protocol: A reaches them only
        // through Deps (AuthEnv.deps, A's own field). Passed as a value, so the call compiles before A adds the field.
        const authEnv = { options, clock: deps.clock, deps }
        keep(await registerAuth(ctx, authEnv))
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
        const cost = keep((await (seam.cost ?? (registerCost as ColabSeam["cost"])!)(ctx as never, deps)) as CostRegistration)
        for (const problem of cost.problems ?? []) problems.set(`cost:${problem}`, costProblem(problem))
      } catch (error) {
        await cleanup().catch(() => undefined)
        throw error
      }
      return cleanup
    },
  })
}
