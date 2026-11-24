import { realpath } from "node:fs/promises"
import { Plugin } from "@opencode/plugin"
import { registerToolsRpc, toolsRpcId } from "@we-the-rebel-alliance/source-contract/tools-rpc"
import { NAMESPACE, PLUGIN_ID, SUPPORTED_HOST } from "../constants.js"
import { ColabError } from "../domain/errors.js"
import { checkHost, isTestedHost } from "../host-version.js"
import { containsDefaults, registerRules } from "../permission-defaults.js"
import { reasonOf } from "../redact.js"
import { AGENT_STEP, type Status } from "../rpc.js"
import { registerSkills, SKILL_IDS, skillPath } from "../skills.js"
import { registerStatusSurface } from "../status-surface.js"
import { PLUGIN_VERSION } from "../version.js"
import { loadEditingOptions } from "./options.js"
import { buildEditingTool, editingDefaults, editingMethods, EDITING_NEXT, guardedAssert, hasBroaderEditEffect, hasScopedEditRule, NAMESPACE_DESCRIPTION, surfaceRules, SURFACE_TOOLS, type Runner } from "./tools.js"

export const TOOLS_RPC_ID = toolsRpcId(PLUGIN_ID)

type Location = { readonly directory: string; readonly workspaceID?: string; readonly project: { readonly id: string } }
type Session = { readonly id: string; readonly agent?: string; readonly location: { readonly directory: string; readonly workspaceID?: string }; readonly projectID: string }

/** Use the host's identities, not the working directory or any caller-supplied account. */
export function verifyLocalSession(location: Location, sessionID: string, session: Session, agent?: string) {
  if (session.id !== sessionID || session.location.directory !== location.directory ||
      session.location.workspaceID !== location.workspaceID || session.projectID !== location.project.id) {
    throw new ColabError("INPUT_INVALID", "That session is not in this plugin location.", { next: "Use a session created in this same OpenCode location." })
  }
  if (agent !== undefined && (!agent || session.agent !== agent)) {
    throw new ColabError("INPUT_INVALID", "The call does not match the session's agent.", { next: "Use the agent selected for this session." })
  }
  return session
}

export function createEditingPlugin() {
  return Plugin.define({
    id: PLUGIN_ID,
    async setup(ctx) {
      const options = loadEditingOptions(ctx.options)
      const hostWarning = checkHost(ctx.app.version, options.allowUntestedHost)
      // The host selects this trust anchor. File inputs below it may not traverse symbolic links.
      const directory = await realpath(ctx.location.directory)
      const problems = new Map<string, string>()
      const report = (area: string) => (problem?: string) => void (problem ? problems.set(area, problem) : problems.delete(area))
      const defaults = surfaceRules(options.access)
      const registrations: { dispose(): Promise<void> }[] = []
      const cleanup = async () => {
        for (const registration of registrations.splice(0).reverse()) await registration.dispose()
      }
      const get = async ({ sessionID }: Parameters<typeof ctx.session.get>[0]) => {
        const info = await ctx.session.get({ sessionID })
        verifyLocalSession(ctx.location, sessionID, info)
        return info
      }
      const runner: Runner = {
        directory,
        options,
        async verify(call) {
          call.signal.throwIfAborted()
          const session = await get({ sessionID: call.sessionID as never })
          verifyLocalSession(ctx.location, call.sessionID, session, call.agent)
        },
        assert: guardedAssert(async (request) => {
          if (request.action === "colab.edit" && options.access !== "all") {
            const [{ data: agent }, session] = await Promise.all([
              ctx.agent.get({ agentID: request.agent as never }),
              get({ sessionID: request.sessionID as never }),
            ])
            verifyLocalSession(ctx.location, request.sessionID, session, request.agent)
            const rules = [...agent.permissions, ...(session.permissions ?? [])]
            if (problems.has("rules") || !hasScopedEditRule(rules) || hasBroaderEditEffect(rules)) {
              throw new ColabError("PERMISSION_DENIED", "The restricted editing defaults could not be enforced for this call.", {
                next: "Use an agent with the plugin's default rules, or configure an explicit colab.edit rule for this agent.",
              })
            }
          }
          await ctx.permission.assert(request as never)
        }),
      }
      try {
        registrations.push(await registerRules(ctx, defaults, report("rules"), (rules) => editingDefaults(rules, defaults, options.access)))
        registrations.push(await ctx.tool.transform((editor) => {
          try {
            editor.namespace({ name: NAMESPACE, description: NAMESPACE_DESCRIPTION })
            for (const tool of SURFACE_TOOLS) editor.add(buildEditingTool(tool, runner) as never)
            report("tools")(undefined)
          } catch (error) {
            report("tools")(new ColabError("TOOLS_NOT_REGISTERED", `The Colab tools could not be registered (${reasonOf(error)}).`).message)
          }
        }))
        registrations.push(await registerStatusSurface(ctx, async (): Promise<Status> => {
          const [agents, skills] = await Promise.all([ctx.agent.list(), ctx.skill.list().then((result) => result.data, () => [])])
          const unguarded = agents.data.filter((agent) => !containsDefaults(agent.permissions, defaults)).map(({ id }) => id)
          const shadowed = skills.filter((skill) => (SKILL_IDS as readonly string[]).includes(skill.id) && skill.path !== skillPath(skill.id))
            .map(({ id, path }) => ({ id, path }))
          return {
            version: PLUGIN_VERSION, surface: "editing", access: options.access, accounts: [],
            tools: { registered: problems.has("tools") ? 0 : SURFACE_TOOLS.length },
            unguardedAgents: unguarded,
            ...(unguarded.length ? { permissionsBlock: defaults } : {}),
            ...(shadowed.length ? { shadowedSkills: shadowed } : {}),
            ...(problems.size ? { problems: [...problems.values()] } : {}),
            host: { version: ctx.app.version, range: SUPPORTED_HOST, tested: isTestedHost(ctx.app.version) },
            ...(hostWarning ? { hostWarning } : {}),
            cost: { runtimeHoursToday: 0, runtimesRunning: 0 }, automation: "off",
            nextStep: [...problems.values()][0]?.split("Next step: ")[1] ??
              (unguarded.length ? AGENT_STEP : undefined) ??
              (shadowed.length ? "Rename or move the skills that shadow the plugin's skills." : undefined) ?? EDITING_NEXT,
          }
        }))
        const dispose = await registerToolsRpc({ rpc: ctx.rpc, permission: ctx.permission, agent: ctx.agent, tool: ctx.tool, mcp: ctx.mcp, location: ctx.location, session: { get } } as never, {
          plugin: {
            id: PLUGIN_ID,
            nextSteps: {
              SESSION_UNKNOWN: "Create an OpenCode session in this project and pass its id.",
              SESSION_AGENT_REQUIRED: "Select an agent for the session and try again.",
              PERMISSION_DENIED: "Use a session whose agent and session rules already allow the requested read.",
              CANCELLED: "Call the method again if you still need the result.",
            },
            pluginError: (error) => ColabError.is(error) ? { code: error.code, what: error.detail.replace(/\.$/, ""), next: error.next } : undefined,
          },
          methods: editingMethods(runner),
        })
        registrations.push({ dispose })
        registrations.push(await registerSkills(ctx))
        return cleanup
      } catch (error) {
        await cleanup().catch(() => undefined)
        throw error
      }
    },
  })
}
