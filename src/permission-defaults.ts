// Host permission defaults and rule evaluation, shared without loading either tool catalogue.
import type { Plugin } from "@opencode/plugin"
import type { Access } from "./constants.js"
import { ColabError } from "./domain/errors.js"
import { reasonOf } from "./redact.js"

export type Rule = { readonly action: string; readonly resource: string; readonly effect: "allow" | "ask" | "deny" }

/** What a change gets at each access. */
export function changeEffect(access: Access): Rule["effect"] {
  return access === "all" ? "allow" : access === "ask-changes" ? "ask" : "deny"
}

const isBaseAllow = (item: Rule) => item.action === "*" && item.resource === "*" && item.effect === "allow"
const same = (a: Rule, b: Rule) => a.action === b.action && a.resource === b.resource && a.effect === b.effect

/** Inserts `defaults` right after the first base allow rule, unless the block is already after it. */
export function insertDefaults<R extends Rule>(rules: readonly R[], defaults: readonly R[], includeWithoutBase = false): R[] {
  const base = rules.findIndex(isBaseAllow)
  if ((base === -1 && !includeWithoutBase) || hasBlockAfter(rules, base, defaults)) return [...rules]
  return [...rules.slice(0, base + 1), ...defaults.map((item) => ({ ...item })), ...rules.slice(base + 1)]
}

/** A Colab action the plugin does not know: what an agent's rules do for it shows whether a new tool would run unasked. */
const UNKNOWN_ACTION = "colab.unknown_tool"

/** Agents without the block whose own rules would let an unknown Colab action run without asking. */
export function unguardedBy(agents: readonly { readonly id: string; readonly permissions: readonly Rule[] }[], defaults: readonly Rule[]): string[] {
  return agents
    .filter((agent) => {
      const base = agent.permissions.findIndex(isBaseAllow)
      return base === -1 || !hasBlockAfter(agent.permissions, base, defaults)
    })
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
  for (let start = base + 1; start + defaults.length <= rules.length; start++) {
    if (defaults.every((item, index) => rules[start + index] !== undefined && same(rules[start + index]!, item))) return true
  }
  return false
}

export const containsDefaults = (rules: readonly Rule[], defaults: readonly Rule[]) => hasBlockAfter(rules, -1, defaults)

type AgentContext = { readonly agent: Pick<Plugin.Context["agent"], "transform"> }

/** Registers the default rules for every agent. Synchronous and never throws; a failure is kept for status. */
export async function registerRules(ctx: AgentContext, defaults: readonly Rule[], report: (problem: string | undefined) => void, apply = (rules: readonly Rule[]) => insertDefaults(rules, defaults)): Promise<{ dispose(): Promise<void> }> {
  return ctx.agent.transform((editor) => {
    try {
      for (const agent of editor.list()) {
        editor.update(agent.id, (item) => {
          item.permissions = apply(item.permissions)
        })
      }
      report(undefined)
    } catch (error) {
      report(new ColabError("RULES_NOT_ADDED", `Colab's default permission rules could not be added (${reasonOf(error)}), so Colab tools may run without asking.`).message)
    }
  })
}
