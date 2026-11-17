// Package C, Notebooks (docs/v1-design.md, File ownership): the nbformat model, colab_notebook, colab_edit,
// colab_find, the Drive pull (DriveSync) and the drive.create / drive.update / drive.trash plans with sync records,
// the foreign-origin warning, pushOutputs and the source secret screen. Day 0 stubs answer NOT_IMPLEMENTED.
import type { PortEnv } from "../deps.js"
import type { DriveApi, DriveSync } from "../ports.js"
import { notImplemented, stubPort } from "../stub.js"
import type { PlanHandler, PlanHandlers, ToolHandlers } from "../tools/types.js"

export const HANDLERS: ToolHandlers = {
  find: { run: async () => notImplemented("colab_find") },
  notebook: { run: async () => notImplemented("colab_notebook") },
  edit: { run: async () => notImplemented("colab_edit") },
}

const stubPlan = (action: string): PlanHandler<never> => ({ preview: async () => notImplemented(`The ${action} plan`), commit: async () => notImplemented(`The ${action} plan`) })

export const PLAN_HANDLERS: PlanHandlers = {
  "drive.create": { colab: stubPlan("drive.create"), enterprise: stubPlan("drive.create") },
  "drive.update": { colab: stubPlan("drive.update"), enterprise: stubPlan("drive.update") },
  "drive.trash": { colab: stubPlan("drive.trash"), enterprise: stubPlan("drive.trash") },
}

export function createDrivePorts(_env: PortEnv): { readonly drive: DriveApi; readonly driveSync: DriveSync } {
  return { drive: stubPort<DriveApi>("DriveApi"), driveSync: stubPort<DriveSync>("DriveSync") }
}
