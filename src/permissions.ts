// The `access` → default-rules block (design §7.1, §10), inserted into each agent right after its base `* * allow`
// rule. OpenCode applies the last matching rule, so the agent's own stricter rules, the user's `permissions` rules and
// saved approvals all still win. Reads — the twelve read tools, `colab.read` and `colab.probe` — are allowed at every
// level; the eight change tools and the namespace get the change effect (allow / ask / deny); `/colab-cleanup`'s
// action asks at `all` and `ask-changes` (the person-only prompt, design §8.5) and is denied at `read-only`, where the
// command only lists what costs money and takes no action. colab_delete's "never Always" is in its assert (no
// `save`), not here.
import type { Plugin } from "@opencode/plugin"
import { type Access } from "./constants.js"
import { CHANGE_TOOL_ACTIONS, CLEANUP_ACTION, NAMESPACE_ACTION, PERMISSION_ONLY, READ_TOOL_ACTIONS } from "./domain/actions.js"
import { ColabError } from "./domain/errors.js"
import { reasonOf } from "./redact.js"

export type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

/** What a change gets at each access. */
export function changeEffect(access: Access): Rule["effect"] {
  return access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
}

/** `/colab-cleanup`: a person-only ask, except at read-only, where it reports and takes nothing (design §8.5). */
export function cleanupEffect(access: Access): Rule["effect"] {
  return access === "read-only" ? "deny" : "ask"
}

/** Broad first, narrow last, because the last matching rule wins. */
export function defaultRules(access: Access = "all"): Rule[] {
  const change = changeEffect(access)
  return [
    rule(NAMESPACE_ACTION, change),
    ...READ_TOOL_ACTIONS.map((action) => rule(action, "allow")),
    ...PERMISSION_ONLY.map((entry) => rule(entry.action, "allow")),
    ...CHANGE_TOOL_ACTIONS.map((action) => rule(action, change)),
    rule(CLEANUP_ACTION, cleanupEffect(access)),
  ]
}

const isBaseAllow = (item: Rule) => item.action === "*" && item.resource === "*" && item.effect === "allow"
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/** Inserts `defaults` right after the first base allow rule, unless the block is already after it. */
export function insertDefaults<R extends Rule>(rules: readonly R[], defaults: readonly R[]): R[] {
  const base = rules.findIndex(isBaseAllow)
  if (base === -1 || hasBlockAfter(rules, base, defaults)) return [...rules]
  return [...rules.slice(0, base + 1), ...defaults.map((item) => ({ ...item })), ...rules.slice(base + 1)]
}

/** A Colab action the plugin does not know: what an agent's rules do for it shows whether a new tool would run unasked. */
const UNKNOWN_ACTION = "colab.unknown_tool"

/** Agents without the block whose own rules would let an unknown Colab action run without asking. */
export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  const defaults = defaultRules(access)
  return agents
    .filter((agent) => !hasBlockAfter(agent.permissions, agent.permissions.findIndex(isBaseAllow), defaults))
    .filter((agent) => effectOf(agent.permissions, UNKNOWN_ACTION) === "allow")
    .map((agent) => agent.id)
}

/** OpenCode's wildcards: `*` matches any run of characters and `?` one character, over the whole text. */
export const matches = (pattern: string, value: string) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`).test(value)

/** The effect of `rules` for one call: the last rule whose action and resource both match wins, and no match asks. */
export function effectOf(rules: readonly Rule[], action: string, resource = "*"): Rule["effect"] {
  return rules.findLast((item) => matches(item.action, action) && matches(item.resource, resource))?.effect ?? "ask"
}

function hasBlockAfter(rules: readonly Rule[], base: number, defaults: readonly Rule[]): boolean {
  if (base === -1) return false
  for (let start = base + 1; start + defaults.length <= rules.length; start++) {
    if (defaults.every((item, index) => rules[start + index] !== undefined && same(rules[start + index]!, item))) return true
  }
  return false
}

type AgentContext = { readonly agent: Pick<Plugin.Context["agent"], "transform"> }

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export async function registerPermissionDefaults(ctx: AgentContext, access: Access, report: (problem: string | undefined) => void): Promise<{ dispose(): Promise<void> }> {
  const defaults = defaultRules(access)
  return ctx.agent.transform((editor) => {
    try {
      for (const agent of editor.list()) {
        editor.update(agent.id, (item) => {
          item.permissions = insertDefaults(item.permissions, defaults)
        })
      }
      report(undefined)
    } catch (error) {
      report(new ColabError("RULES_NOT_ADDED", `Colab's default permission rules could not be added (${reasonOf(error)}), so Colab tools may run without asking.`).message)
    }
  })
}
