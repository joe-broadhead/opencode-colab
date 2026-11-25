// Package E, Enterprise (docs/v1-design.md, File ownership): jobs (plans, ids, polling, GCS capture, cancel), schedules
// (plans, bounds, overlap, displayName reconcile), colab_pause, Enterprise runtime list and stop/delete plans, the price
// table and estimates, colab_jobs / colab_schedules, and the Enterprise branches of colab_execution, colab_cancel and
// colab_download (EnterpriseRuns). The Vertex and Cloud Storage clients are here too, over `fetch`; every test uses fakes.
import type { PortEnv } from "../index.js"
import type { EnterpriseRuns, GcsApi, Prices, VertexApi } from "../ports.js"
import type { PlanHandlers, ToolHandlers } from "../types.js"
import { createGcs } from "./gcs.js"
import { createPrices } from "./prices.js"
import { jobsHandler } from "./jobs.js"
import { pauseHandler } from "./pause.js"
import { PLAN_HANDLERS as JOB_PLAN_HANDLERS } from "./plans.js"
import { createEnterpriseRuns, type EnterpriseRunsEnv } from "./runs.js"
import { PLAN_HANDLERS as SCHEDULE_PLAN_HANDLERS } from "./schedule-plans.js"
import { schedulesHandler } from "./schedules.js"
import { createVertex } from "./vertex.js"

export const HANDLERS: ToolHandlers = {
  jobs: jobsHandler,
  schedules: schedulesHandler,
  pause: pauseHandler,
}

export const PLAN_HANDLERS: PlanHandlers = {
  ...JOB_PLAN_HANDLERS,
  ...SCHEDULE_PLAN_HANDLERS,
}

export function createEnterprisePorts(env: PortEnv): { readonly vertex: VertexApi; readonly gcs: GcsApi; readonly enterprise: EnterpriseRuns; readonly prices: Prices } {
  const vertex = createVertex(env)
  const gcs = createGcs(env)
  const runs: EnterpriseRunsEnv = { ...env, vertex, gcs }
  return { vertex, gcs, enterprise: createEnterpriseRuns(runs), prices: createPrices(env) }
}
