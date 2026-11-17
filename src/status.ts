// One status, computed fresh on every call, behind /colab-status and the RPC method the TUI view uses. It makes no
// Google call: it reads OpenCode's own state and the plugin's options. Package F grows it.
import type { Plugin } from "@opencode/plugin"
import { type Access, DISPLAY_NAME, STATUS_COMMAND, SUPPORTED_HOST, TESTED_HOSTS } from "./constants.js"
import { ColabError } from "./domain/errors.js"
import { isTestedHost } from "./host-version.js"
import { defaultRules, unguardedAgents } from "./permissions.js"
import { AGENT_STEP, type AccountRow, ColabRpc, formatStatus, NOTHING_TO_DO, type SkillPath, type Status } from "./rpc.js"
import { PLUGIN_VERSION } from "./version.js"

const UNAVAILABLE = new ColabError("STATUS_UNAVAILABLE").message

type StatusContext = {
  readonly agent: Pick<Plugin.Context["agent"], "list">
  readonly skill: Pick<Plugin.Context["skill"], "list">
}

export type StatusDeps = {
  readonly access: Access
  readonly accounts: readonly AccountRow[]
  readonly tools: () => { readonly registered: number }
  readonly hostVersion: string
  readonly hostWarning?: string
  readonly skills: readonly SkillPath[]
  readonly problems: () => readonly string[]
}

export async function computeStatus(ctx: StatusContext, deps: StatusDeps): Promise<Status> {
  const [agents, listed] = await Promise.all([ctx.agent.list(), ctx.skill.list().then((result) => result.data, () => undefined)])
  const unguarded = unguardedAgents(agents.data, deps.access)
  const shadowed = shadowedSkills(deps.skills, listed ?? [])
  const problems = deps.problems()
  return {
    version: PLUGIN_VERSION,
    access: deps.access,
    accounts: deps.accounts.map((item) => ({ ...item })),
    tools: { ...deps.tools() },
    unguardedAgents: unguarded,
    ...(unguarded.length > 0 ? { permissionsBlock: defaultRules(deps.access) } : {}),
    ...(shadowed.length > 0 ? { shadowedSkills: shadowed } : {}),
    ...(problems.length > 0 ? { problems: [...problems] } : {}),
    host: { version: deps.hostVersion, range: SUPPORTED_HOST, tested: isTestedHost(deps.hostVersion) },
    ...(deps.hostWarning ? { hostWarning: deps.hostWarning } : {}),
    nextStep:
      problems[0]?.split("Next step: ")[1] ??
      (unguarded.length > 0 ? AGENT_STEP : undefined) ??
      skillStep(shadowed) ??
      (deps.hostWarning ? `If ${DISPLAY_NAME} misbehaves, use OpenCode ${TESTED_HOSTS.slice(0, -1).join(", ")} or ${TESTED_HOSTS.at(-1)}, where it is tested.` : undefined) ??
      NOTHING_TO_DO,
  }
}

function shadowedSkills(own: readonly SkillPath[], listed: readonly SkillPath[]): SkillPath[] {
  return own.flatMap((skill) => {
    const found = listed.find((item) => item.id === skill.id)
    return found && found.path !== skill.path ? [{ id: skill.id, path: found.path }] : []
  })
}

function skillStep(shadowed: readonly SkillPath[]): string | undefined {
  if (shadowed.length === 0) return undefined
  return `Rename or move ${shadowed.map((skill) => `the "${skill.id}" skill at ${skill.path}`).join(" and ")}, which OpenCode loads instead of the plugin's skill of the same name.`
}

type RegisterContext = StatusContext & {
  readonly command: Pick<Plugin.Context["command"], "transform">
  readonly rpc: Pick<Plugin.Context["rpc"], "register">
  readonly session: Pick<Plugin.Context["session"], "synthetic">
}

export async function registerStatus(ctx: RegisterContext, deps: StatusDeps): Promise<{ dispose(): Promise<void> }> {
  const compute = () => computeStatus(ctx, deps)
  const registrations: Array<{ dispose(): Promise<void> }> = []
  try {
    registrations.push(
      await ctx.command.transform((editor) => {
        editor.add({
          name: STATUS_COMMAND,
          description: `Show ${DISPLAY_NAME}'s accounts, access and what to do next`,
          execute: async ({ sessionID, delivery }) => {
            const text = await compute().then(formatStatus, () => UNAVAILABLE)
            await ctx.session.synthetic({ sessionID, delivery, text, description: `${DISPLAY_NAME} status`, resume: false })
          },
        })
      }),
    )
    registrations.push(
      await ctx.rpc.register(ColabRpc, {
        status: async (_input, { error }) => {
          try {
            return await compute()
          } catch {
            return error("unavailable", UNAVAILABLE, { reason: "OpenCode did not report the agents." })
          }
        },
      }),
    )
  } catch (cause) {
    for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    throw cause
  }
  return {
    async dispose() {
      for (const registration of registrations.splice(0).reverse()) await registration.dispose()
    },
  }
}
