// The status contract shared by the server part, /colab-status and the TUI view. Portable and small: it imports only
// the RPC definition helper and constants, and the contract is plain JSON Schema, so the TUI bundle carries no zod.
// Package F grows it (cost, runtimes, automation); Day 0 reports the accounts, the rules and the host.
import { Rpc } from "@opencode/plugin/rpc"
import { ACCESS_VALUES, type Access, DISPLAY_NAME, PLUGIN_ID, STATUS_COMMAND } from "./constants.js"

const EFFECTS = ["allow", "ask", "deny"] as const
const BACKENDS = ["colab", "enterprise"] as const
/** The automation states design §8.3 step 4 names; src/cost/automation.ts returns exactly these. */
export const AUTOMATION_STATES = ["on", "on (consent)", "off", "off (access)", "not-owner"] as const
export type AutomationRow = (typeof AUTOMATION_STATES)[number]

export type Rule = { readonly action: string; readonly resource: string; readonly effect: (typeof EFFECTS)[number] }
export type SkillPath = { readonly id: string; readonly path: string }
export type AccountRow = { readonly alias: string; readonly backend: (typeof BACKENDS)[number] }

/** The Cost row (design §8.4): runtime-hours, runtimes, and the one cleanup call; no consumer rate is published. */
export type CostRow = {
  readonly runtimeHoursToday: number
  readonly runtimesRunning: number
  /** Runtimes of ours running with no run of ours active. */
  readonly noRunActive: number
  readonly topCleanup?: string
  /** Runtimes the automation leaves alone and why, in the plugin's own words (design §8.3). */
  readonly attention?: readonly string[]
}

export type Status = {
  readonly version: string
  readonly access: Access
  readonly accounts: readonly AccountRow[]
  /** How many tools are registered. */
  readonly tools: { readonly registered: number }
  readonly unguardedAgents: readonly string[]
  readonly permissionsBlock?: readonly Rule[]
  readonly shadowedSkills?: readonly SkillPath[]
  readonly problems?: readonly string[]
  readonly host: { readonly version: string; readonly range: string; readonly tested: boolean }
  readonly hostWarning?: string
  readonly cost: CostRow
  readonly automation: AutomationRow
  readonly nextStep: string
}

const text = { type: "string" } as const
const texts = { type: "array", items: text } as const
const count = { type: "integer", minimum: 0 } as const
const object = (properties: Record<string, object>, required: readonly string[]) => ({ type: "object", properties, required, additionalProperties: false }) as const

const rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"])
const skillPath = object({ id: text, path: text }, ["id", "path"])
const account = object({ alias: text, backend: { enum: BACKENDS } }, ["alias", "backend"])
const nonNegative = { type: "number", minimum: 0 } as const
const cost = object(
  {
    runtimeHoursToday: nonNegative,
    runtimesRunning: count,
    noRunActive: count,
    topCleanup: text,
    attention: texts,
  },
  ["runtimeHoursToday", "runtimesRunning", "noRunActive"],
)

export const STATUS_SCHEMA = object(
  {
    version: text,
    access: { enum: ACCESS_VALUES },
    accounts: { type: "array", items: account },
    tools: object({ registered: count }, ["registered"]),
    unguardedAgents: texts,
    permissionsBlock: { type: "array", items: rule },
    shadowedSkills: { type: "array", items: skillPath },
    problems: texts,
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    cost,
    automation: { enum: AUTOMATION_STATES },
    nextStep: text,
  },
  ["version", "access", "accounts", "tools", "unguardedAgents", "host", "cost", "automation", "nextStep"],
)

export const ColabRpc = Rpc.define({
  id: PLUGIN_ID,
  methods: {
    status: { input: object({}, []), output: STATUS_SCHEMA, errors: { unavailable: object({ reason: text }, ["reason"]) } },
  },
  events: {},
})

type Record_ = Record<string, unknown>
const isRecord = (value: unknown): value is Record_ => typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string"
const isTexts = (value: unknown) => Array.isArray(value) && value.every(isText)
const isCount = (value: unknown) => Number.isInteger(value) && (value as number) >= 0
const only = (value: Record_, keys: readonly string[]) => Object.keys(value).every((key) => keys.includes(key))
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value)
const isRule = (value: unknown) => isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && EFFECTS.includes(value.effect as never)
const isSkillPath = (value: unknown) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path)
const isAccount = (value: unknown) => isRecord(value) && only(value, ["alias", "backend"]) && isText(value.alias) && BACKENDS.includes(value.backend as never)
const isNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0
const isCost = (value: unknown) =>
  isRecord(value) &&
  only(value, ["runtimeHoursToday", "runtimesRunning", "noRunActive", "topCleanup", "attention"]) &&
  isNumber(value.runtimeHoursToday) &&
  isCount(value.runtimesRunning) &&
  isCount(value.noRunActive) &&
  optional(value.topCleanup, isText) &&
  optional(value.attention, isTexts)

/** JSON Schema outputs reach clients unchecked, so readers check a status against the schema's rules. */
export function isStatus(value: unknown): value is Status {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false
  const { tools, host } = value
  return (
    isText(value.version) &&
    ACCESS_VALUES.includes(value.access as never) &&
    Array.isArray(value.accounts) && value.accounts.every(isAccount) &&
    isRecord(tools) && only(tools, ["registered"]) && isCount(tools.registered) &&
    isTexts(value.unguardedAgents) &&
    optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) &&
    optional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) &&
    optional(value.problems, isTexts) &&
    isRecord(host) && only(host, ["version", "range", "tested"]) && isText(host.version) && isText(host.range) && typeof host.tested === "boolean" &&
    optional(value.hostWarning, isText) &&
    isCost(value.cost) &&
    AUTOMATION_STATES.includes(value.automation as never) &&
    isText(value.nextStep)
  )
}

export const NOTHING_TO_DO = "Nothing to do."
export { STATUS_COMMAND }

/** The next step for agents without the default rules: one fixed sentence across the plugins, with no names. */
export const AGENT_STEP = `Put the default rules shown by /${STATUS_COMMAND} first in each listed agent's own permissions, in opencode.json or the agent's Markdown file, followed by your top-level rules for ${DISPLAY_NAME} tools.`

export type StatusRow = { readonly label: string; readonly value: string }

export function formatRules(rules: readonly Rule[]): string {
  return `[\n${rules.map((item) => `  ${JSON.stringify(item)}`).join(",\n")}\n]`
}

const ACCESS_TEXT: Record<Access, string> = {
  all: "every tool runs without asking, code included, as with bash",
  "ask-changes": "reads and previews run without asking; every change asks first, and colab_run's ask shows the code",
  "read-only": "reads and previews run without asking; every change is denied",
}

function describeHost(status: Pick<Status, "host" | "hostWarning">): string {
  if (status.host.tested) return `${status.host.version} (tested)`
  if (status.hostWarning) return `${status.host.version} (untested: ${status.hostWarning})`
  return `${status.host.version} (untested; supported range ${status.host.range})`
}

const automationText = (state: AutomationRow): string =>
  state === "on (consent)" ? "on (your option)" : state === "off (access)" ? "off at this access level" : state === "not-owner" ? "another process owns it" : state

/** The Cost row, one line: runtime-hours, runtimes, today's USD when known, and the top cleanup call. */
export function costText(cost: CostRow): string {
  const hours = `${cost.runtimeHoursToday.toFixed(1)} runtime-hour${cost.runtimeHoursToday === 1 ? "" : "s"} today`
  const running = `${cost.runtimesRunning} running`
  const cleanup = cost.topCleanup ? `; cleanup: ${cost.topCleanup}` : ""
  return `${hours}; ${running}${cleanup}`
}

/** The status as labelled rows, in the order the dialog and /colab-status show them. */
export function statusRows(status: Status): StatusRow[] {
  return [
    { label: "Accounts", value: status.accounts.map((item) => `${item.alias} (${item.backend})`).join(", ") },
    { label: "Access", value: ACCESS_TEXT[status.access] },
    { label: "Tools", value: `${status.tools.registered} registered` },
    { label: "Agents without default rules", value: status.unguardedAgents.length > 0 ? status.unguardedAgents.join(", ") : "none" },
    { label: "Cost", value: `${costText(status.cost)}${status.cost.noRunActive > 0 ? `, ${status.cost.noRunActive} with no run active` : ""}` },
    { label: "Automation", value: automationText(status.automation) },
    ...(status.cost.attention?.length ? [{ label: "Attention", value: status.cost.attention.join(" ") }] : []),
    ...(status.shadowedSkills?.length ? [{ label: "Skills", value: status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ") }] : []),
    ...(status.problems?.length ? [{ label: "Problems", value: status.problems.join(" ") }] : []),
    { label: "OpenCode", value: describeHost(status) },
    { label: "Next step", value: status.nextStep },
  ]
}

export function formatStatus(status: Status): string {
  const lines: string[] = [`${DISPLAY_NAME} status`]
  for (const row of statusRows(status)) {
    lines.push(`${row.label}: ${row.value}`)
    if (row.label === "Agents without default rules" && status.unguardedAgents.length > 0) lines.push(formatRules(status.permissionsBlock ?? []))
  }
  return lines.join("\n")
}
