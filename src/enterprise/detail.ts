/**
 * The compute a job or a schedule runs on, read from Google's own fields, plus the two `Schedule` fields the plugin's
 * overlap guard still reads on their own (`maxConcurrentRunCount`, `allowQueueing`) until the port carries them.
 *
 * `EnterpriseJob` and `EnterpriseSchedule` now hold the fields the design's reads show (Day 0 amendment): a job's
 * machine, accelerator, timeout and template, and a schedule's job request and next run time.
 */
import type { EnterpriseSchedule } from "../ports.js"

export interface ComputeSpec {
  readonly machine?: string
  readonly accelerator?: string
  readonly acceleratorCount?: number
  readonly template?: string
  readonly timeoutSeconds?: number
}

/** A schedule that can start more than one run at once, or queue runs: its runs can overlap (review LOW 8). */
export interface ScheduleOverlap {
  readonly maxConcurrentRunCount?: number
  readonly allowQueueing?: boolean
}

export const overlapOf = (schedule: EnterpriseSchedule) => schedule as EnterpriseSchedule & ScheduleOverlap

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
  return computeOfJobBody(record(schedule.jobRequest?.notebookExecutionJob))
}
