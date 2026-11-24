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
import { changeEffect, registerRules, unguardedBy, type Rule } from "./permission-defaults.js"
export { changeEffect, effectOf, insertDefaults, matches, type Rule } from "./permission-defaults.js"

const rule = (action: string, effect: Rule["effect"]): Rule => ({ action, resource: "*", effect })

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

export function unguardedAgents(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], access: Access = "all"): string[] {
  return unguardedBy(agents, defaultRules(access))
}

export function registerPermissionDefaults(ctx: { readonly agent: Pick<Plugin.Context["agent"], "transform"> }, access: Access, report: (problem: string | undefined) => void) {
  return registerRules(ctx, defaultRules(access), report)
}
