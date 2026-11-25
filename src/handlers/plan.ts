/**
 * The plan/commit pair: `plan_write` previews a change and `plan_delete` previews a destructive one; `write` and
 * `delete` commit exactly the plan the register minted. The register mints and expires the id, binds it to the account
 * and the committing method, and refuses a second commit; the provider's own preview/commit pair re-reads the target and
 * refuses PLAN_CHANGED when it moved.
 */
import { COMMIT_INPUT, refusal, RegisterError, type MethodHandler } from "@we-the-rebel-alliance/plugin-contract/register"
import { type Backend, COMMIT_METHOD, PLAN_ACTIONS, PLAN_ACTION_NAMES, type PlanAction, type PlanCategory, REFUSED_PLAN_ACTIONS } from "../domain/actions.js"
import { PLAN_PARAMS } from "../domain/contract.js"
import type { Deps } from "../provider/index.js"
import * as enterprise from "../provider/enterprise/index.js"
import * as execution from "../provider/execution/index.js"
import * as notebooks from "../provider/notebooks/index.js"
import type { PlanHandler, PlanHandlers } from "../provider/types.js"
import { assertWritable, providerAccount, providerContext } from "./context.js"
import { mapped } from "./errors.js"

/** Merge by action and backend: two packages may plan the same action on different accounts. */
function mergedPlans(): PlanHandlers {
  const merged: Record<string, Record<string, PlanHandler<PlanAction>>> = {}
  for (const source of [notebooks.PLAN_HANDLERS, execution.PLAN_HANDLERS, enterprise.PLAN_HANDLERS]) {
    for (const [action, entry] of Object.entries(source) as [PlanAction, Partial<Record<Backend, PlanHandler<PlanAction>>>][]) {
      merged[action] ??= {}
      Object.assign(merged[action]!, entry)
    }
  }
  return merged as PlanHandlers
}
const PLAN_HANDLERS: PlanHandlers = mergedPlans()

const INPUT = {
  type: "object",
  properties: {
    action: { type: "string", minLength: 1, maxLength: 64, description: "The action to preview, such as runtime.create or job.create." },
    params: { type: "object", additionalProperties: true, description: "The action's own parameters." },
  },
  required: ["action"],
  additionalProperties: false,
}

const OUTPUT = {
  type: "object",
  properties: { state: { type: "string" }, action: { type: "string" }, result: { type: "object", additionalProperties: true } },
  additionalProperties: true,
}

interface Planned {
  readonly action: PlanAction
  readonly category: PlanCategory
  readonly preview: Readonly<Record<string, unknown>>
  readonly payload: Readonly<Record<string, unknown>>
  readonly fingerprint: Readonly<Record<string, unknown>>
  readonly operation: string
}

const isPlanAction = (action: string): action is PlanAction => Object.hasOwn(PLAN_ACTIONS, action)

/** The provider handler for one action on one backend, or the refusal that says why it has none. */
function providerPlan(action: string, backend: Backend): PlanHandler<PlanAction> {
  const refused = (REFUSED_PLAN_ACTIONS as Readonly<Record<string, string>>)[action]
  if (refused !== undefined) throw new RegisterError(refusal("INPUT_INVALID", `The plugin never plans ${action}`, `Use one of: ${PLAN_ACTION_NAMES.join(", ")}.`))
  if (!isPlanAction(action)) throw new RegisterError(refusal("INPUT_INVALID", `There is no plan action ${action}`, `Use one of: ${PLAN_ACTION_NAMES.join(", ")}.`))
  if (!(PLAN_ACTIONS[action].backends as Partial<Record<Backend, unknown>>)[backend]) {
    const next = action === "runtime.create" && backend === "enterprise" ? 'Plan job.create with a notebook instead: Enterprise runs whole notebooks as jobs.' : `Use an account whose backend has ${action}.`
    throw new RegisterError(refusal("INPUT_INVALID", `${action} is not available on ${backend} accounts in this build`, next))
  }
  const handler = PLAN_HANDLERS[action]?.[backend] as PlanHandler<PlanAction> | undefined
  if (handler === undefined) throw new RegisterError(refusal("UNAVAILABLE", `The ${String(action)} plan on ${backend} accounts is not built`, "Use another action, or check the plugin's status."))
  return handler
}

function paramsFor(action: PlanAction, raw: unknown): unknown {
  const parsed = PLAN_PARAMS[action].safeParse(raw ?? {})
  if (parsed.success) return parsed.data
  const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ")
  throw new RegisterError(refusal("INPUT_INVALID", `${action}'s params are invalid: ${problems}`, "Pass the params the action's schema describes."))
}

/** What the preview changes, in one line per visible effect. */
function changesOf(action: PlanAction, preview: Readonly<Record<string, unknown>>): string[] {
  const at = (key: string) => (typeof preview[key] === "string" ? (preview[key] as string) : undefined)
  switch (action) {
    case "runtime.create":
      return [`Create a ${at("spec") ?? "Colab"} runtime.`]
    case "runtime.delete":
      return [`Release runtime ${at("runtime") ?? "the planned runtime"}; files outside keep and memory are lost.`]
    case "runtime.stop":
      return [`Stop runtime ${at("runtime") ?? "the planned runtime"}; kernel state is lost and the disk is kept.`]
    case "job.create":
      return [`Create an Enterprise job${at("displayName") ? ` named ${at("displayName")}` : ""}.`]
    case "job.delete":
      return [`Delete job ${at("job") ?? "the planned job"}.`]
    case "schedule.create":
      return [`Create schedule${at("displayName") ? ` ${at("displayName")}` : ""} with cron ${at("cron") ?? "the planned cron"}.`]
    case "schedule.update":
      return [`Update schedule ${at("schedule") ?? "the planned schedule"}.`]
    case "schedule.resume":
      return [`Resume schedule ${at("schedule") ?? "the planned schedule"}.`]
    case "schedule.delete":
      return [`Delete schedule ${at("schedule") ?? "the planned schedule"}.`]
    case "drive.create":
      return [`Push a new Drive notebook${at("name") ? ` named ${at("name")}` : ""}.`]
    case "drive.update":
      return [`Push a new revision of ${at("drive") ?? "the planned Drive notebook"}.`]
    case "drive.trash":
      return [`Move Drive file ${at("drive") ?? "the planned file"} to the trash.`]
  }
}

function planMethod(category: PlanCategory, deps: Deps): MethodHandler {
  return {
    description:
      category === "write"
        ? "Preview a write-category change (a runtime, job, schedule or Drive push) and get a planId the write method commits. It writes nothing."
        : "Preview a destructive change (releasing a runtime, deleting a job, schedule or Drive file) and get a planId the delete method commits. It writes nothing.",
    input: INPUT,
    output: { type: "object", additionalProperties: true },
    async run(input, call) {
      return mapped(async () => {
        if (typeof input.action !== "string") throw new RegisterError(refusal("INPUT_INVALID", "plan needs an action", "Pass the action to preview."))
        const account = providerAccount(deps, call.account)
        assertWritable(account)
        const handler = providerPlan(input.action, account.backend)
        const action = input.action as PlanAction
        if (PLAN_ACTIONS[action].category !== category) {
          throw new RegisterError(refusal("PLAN_INVALID", `This is a ${PLAN_ACTIONS[action].category} action, not a ${category} one`, `Plan it with plan_${PLAN_ACTIONS[action].category}, then commit it with ${COMMIT_METHOD[PLAN_ACTIONS[action].category]}.`))
        }
        const params = paramsFor(action, input.params)
        const entry = (PLAN_ACTIONS[action].backends as Partial<Record<Backend, { readonly operation: string }>>)[account.backend]!
        const previewed = await handler.preview(params as never, providerContext(deps, account, call))
        return {
          method: COMMIT_METHOD[category],
          output: previewed.preview,
          changes: changesOf(action, previewed.preview),
          trust: "untrusted" as const,
          plan: { action, category, preview: previewed.preview, payload: previewed.payload, fingerprint: previewed.fingerprint, operation: entry.operation } satisfies Planned,
        }
      })
    },
  }
}

function commitMethod(category: PlanCategory, deps: Deps): MethodHandler {
  return {
    description: category === "write" ? "Commit a write plan by its planId. It writes only what the preview showed." : "Commit a delete plan by its planId. It deletes only what the preview showed.",
    input: COMMIT_INPUT,
    output: OUTPUT,
    async run(_input, call) {
      return mapped(async () => {
        const planned = (call.plan as { plan?: Planned } | undefined)?.plan
        if (planned === undefined || planned.category !== category) {
          throw new RegisterError(refusal("PLAN_INVALID", `This plan is not a ${category} plan`, `Plan the change with plan_${category}, then commit the planId it answers.`))
        }
        const account = providerAccount(deps, call.account)
        assertWritable(account)
        const handler = providerPlan(planned.action, account.backend)
        const result = await handler.commit({ payload: planned.payload, fingerprint: planned.fingerprint }, providerContext(deps, account, call))
        if (planned.action.startsWith("runtime.")) {
          await call.bus.emit("changed", { capability: "colab.runtimes", account: account.alias, reason: "write" })
        }
        return { state: "ok", action: planned.action, result }
      })
    },
  }
}

export function planWriteHandler(deps: Deps): MethodHandler {
  return planMethod("write", deps)
}

export function planDeleteHandler(deps: Deps): MethodHandler {
  return planMethod("delete", deps)
}

export function writeHandler(deps: Deps): MethodHandler {
  return commitMethod("write", deps)
}

export function deleteHandler(deps: Deps): MethodHandler {
  return commitMethod("delete", deps)
}
