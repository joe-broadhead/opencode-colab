// Package E, Enterprise (docs/v1-design.md, File ownership): jobs (plans, ids, polling, GCS capture, cancel),
// schedules (plans, bounds, overlap, displayName reconcile), colab_pause, Enterprise runtime list and stop/delete
// plans, the price table and estimates, colab_jobs / colab_schedules, and the Enterprise branches of colab_execution,
// colab_cancel and colab_download (EnterpriseRuns). Day 0 stubs answer NOT_IMPLEMENTED.
import type { PortEnv } from "../deps.js"
import type { EnterpriseRuns, GcsApi, VertexApi } from "../ports.js"
import { notImplemented, stubPort } from "../stub.js"
import type { PlanHandler, PlanHandlers, ToolHandlers } from "../tools/types.js"

export const HANDLERS: ToolHandlers = {
  jobs: { run: async () => notImplemented("colab_jobs") },
  schedules: { run: async () => notImplemented("colab_schedules") },
  pause: { run: async () => notImplemented("colab_pause") },
}

const stubPlan = (action: string): PlanHandler<never> => ({ preview: async () => notImplemented(`The ${action} plan`), commit: async () => notImplemented(`The ${action} plan`) })

export const PLAN_HANDLERS: PlanHandlers = {
  "runtime.stop": { enterprise: stubPlan("runtime.stop") },
  "runtime.delete": { enterprise: stubPlan("runtime.delete") },
  "job.create": { enterprise: stubPlan("job.create") },
  "job.delete": { enterprise: stubPlan("job.delete") },
  "schedule.create": { enterprise: stubPlan("schedule.create") },
  "schedule.update": { enterprise: stubPlan("schedule.update") },
  "schedule.resume": { enterprise: stubPlan("schedule.resume") },
  "schedule.delete": { enterprise: stubPlan("schedule.delete") },
}

export function createEnterprisePorts(_env: PortEnv): { readonly vertex: VertexApi; readonly gcs: GcsApi; readonly enterprise: EnterpriseRuns } {
  return { vertex: stubPort<VertexApi>("VertexApi"), gcs: stubPort<GcsApi>("GcsApi"), enterprise: stubPort<EnterpriseRuns>("EnterpriseRuns") }
}
