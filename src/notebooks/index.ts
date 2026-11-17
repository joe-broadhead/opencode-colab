// Package C, Notebooks (docs/v1-design.md, File ownership): the nbformat model, colab_notebook, colab_edit,
// colab_find, the Drive pull (DriveSync) and the drive.create / drive.update / drive.trash plans with sync records,
// the foreign-origin warning, pushOutputs and the source secret screen.
import type { PortEnv } from "../deps.js"
import type { DriveApi, DriveSync } from "../ports.js"
import type { PlanHandlers, ToolHandlers } from "../tools/types.js"
import { createHttpDriveApi } from "./drive-api.js"
import { CREATE, TRASH, UPDATE } from "./drive-plans.js"
import { edit } from "./edit.js"
import { find } from "./find.js"
import { notebook } from "./notebook.js"
import { createDriveSync } from "./pull.js"

/** The three tools this package owns. */
export const HANDLERS: ToolHandlers = { find, notebook, edit }

/** The three Drive plans, on either account backend: Drive's API is the same for a Colab and an enterprise account. */
export const PLAN_HANDLERS: PlanHandlers = {
  "drive.create": { colab: CREATE, enterprise: CREATE },
  "drive.update": { colab: UPDATE, enterprise: UPDATE },
  "drive.trash": { colab: TRASH, enterprise: TRASH },
}

/** The Drive port and the pull seam, from the plugin's one fetch and its stored grants. */
export function createDrivePorts(env: PortEnv): { readonly drive: DriveApi; readonly driveSync: DriveSync } {
  const drive = createHttpDriveApi(env)
  return { drive, driveSync: createDriveSync(env, drive) }
}
