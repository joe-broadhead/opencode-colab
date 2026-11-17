// Package D, Execution (docs/v1-design.md, File ownership): colab_run (with the code preview in its ask), the consumer
// side of colab_execution and colab_cancel, colab_upload, colab_download (runtime files; Drive goes to DriveSync, GCS
// to EnterpriseRuns), capture, write-back, colab_specs / colab_runtimes / colab_files, and the runtime.create and
// consumer runtime.delete plans (which call Release). Day 0 stubs answer NOT_IMPLEMENTED.
import { notImplemented } from "../stub.js"
import type { PlanHandler, PlanHandlers, ToolHandlers } from "../tools/types.js"

export const HANDLERS: ToolHandlers = {
  specs: { run: async () => notImplemented("colab_specs") },
  runtimes: { run: async () => notImplemented("colab_runtimes") },
  files: { run: async () => notImplemented("colab_files") },
  execution: { run: async () => notImplemented("colab_execution") },
  run: { run: async () => notImplemented("colab_run") },
  cancel: { run: async () => notImplemented("colab_cancel") },
  upload: { run: async () => notImplemented("colab_upload") },
  download: { run: async () => notImplemented("colab_download") },
}

const stubPlan = (action: string): PlanHandler<never> => ({ preview: async () => notImplemented(`The ${action} plan`), commit: async () => notImplemented(`The ${action} plan`) })

export const PLAN_HANDLERS: PlanHandlers = {
  "runtime.create": { colab: stubPlan("runtime.create") },
  "runtime.delete": { colab: stubPlan("runtime.delete") },
}
