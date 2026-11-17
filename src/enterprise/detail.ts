/**
 * The extra detail package E needs beyond the port's fields, and nothing more.
 *
 * `EnterpriseJob` and `EnterpriseSchedule` in `src/ports.ts` are the contract's subset of Google's resources. Two
 * things the design's tools show are not in that subset: an execution job's compute and timeout (`colab_jobs` shows
 * "compute"; a schedule's worst case is $/h × its own timeout), and a schedule's embedded job request (the only place
 * its timeout and template live). Package E's client passes both through as optional properties, E's fake supplies
 * them, and every reader guards for their absence: with any other implementation the fields are simply omitted.
 *
 * A contract request asks for these in `src/ports.ts`
 * (`EnterpriseJob.machineType/acceleratorType/executionTimeoutSeconds`, `EnterpriseSchedule.jobRequest`).
 */
import type { EnterpriseJob, EnterpriseSchedule } from "../ports.js"

export interface JobDetail extends EnterpriseJob {
  readonly machineType?: string
  readonly acceleratorType?: string
  readonly acceleratorCount?: number
  readonly executionTimeoutSeconds?: number
  readonly template?: string
}

export interface ScheduleDetail extends EnterpriseSchedule {
  /** `Schedule.createNotebookExecutionJobRequest`, as Google returns it. */
  readonly jobRequest?: Readonly<Record<string, unknown>>
  readonly nextRunTime?: string
}

export interface ComputeSpec {
  readonly machine?: string
  readonly accelerator?: string
  readonly acceleratorCount?: number
  readonly template?: string
  readonly timeoutSeconds?: number
}

export const TERMINAL_STATES: ReadonlySet<string> = new Set(["JOB_STATE_SUCCEEDED", "JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_PARTIALLY_SUCCEEDED"])

export const isTerminal = (state: string | undefined) => state !== undefined && TERMINAL_STATES.has(state)

/** "3600s" → 3600. */
export function durationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value)
  return match ? Math.round(Number(match[1])) : undefined
}

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined)

const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)

const integer = (value: unknown): number | undefined => (typeof value === "number" ? Math.trunc(value) : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : undefined)

/** The compute a job runs on, from its own request body (`customEnvironmentSpec` or a template). */
export function computeOfJobBody(body: Readonly<Record<string, unknown>> | undefined): ComputeSpec {
  if (!body) return {}
  const custom = record(body.customEnvironmentSpec)
  const machineSpec = record(custom?.machineSpec)
  const accelerator = text(machineSpec?.acceleratorType)
  const template = text(body.notebookRuntimeTemplateResourceName)
  return {
    ...(text(machineSpec?.machineType) !== undefined ? { machine: text(machineSpec?.machineType) } : {}),
    ...(accelerator !== undefined ? { accelerator } : {}),
    ...(integer(machineSpec?.acceleratorCount) !== undefined ? { acceleratorCount: integer(machineSpec?.acceleratorCount) } : {}),
    ...(template !== undefined ? { template } : {}),
    ...(durationSeconds(body.executionTimeout) !== undefined ? { timeoutSeconds: durationSeconds(body.executionTimeout) } : {}),
  }
}

/** The compute a schedule's runs use, from `createNotebookExecutionJobRequest.notebookExecutionJob`. */
export function computeOfSchedule(schedule: EnterpriseSchedule): ComputeSpec {
  const detail = schedule as ScheduleDetail
  const request = record(detail.jobRequest)
  return computeOfJobBody(record(request?.notebookExecutionJob))
}
