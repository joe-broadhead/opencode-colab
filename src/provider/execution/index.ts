/**
 * Package D, Execution (docs/v1-design.md, File ownership): `colab_run` (with the code preview in its ask), the consumer
 * side of `colab_execution` and `colab_cancel`, `colab_upload`, `colab_download` (runtime files; Drive goes to
 * DriveSync, GCS to EnterpriseRuns), capture, the write-back merge, `colab_specs` / `colab_runtimes` / `colab_files`,
 * and the `runtime.create` and consumer `runtime.delete` plans (the latter calls package F's one release function).
 *
 * Everything reaches other packages through `Deps` (src/deps.ts) and the ports (src/ports.ts): the runtime transport
 * and the agent-only check are package B's, the notebook store and the Drive pull are package C's, the Enterprise
 * branches are package E's, and the release is package F's.
 */
import { cancel } from "./cancel.js"
import { download } from "./download.js"
import { execution } from "./execution.js"
import { PLAN_HANDLERS as plans } from "./plans.js"
import { run } from "./run.js"
import { upload } from "./upload.js"
import { files, runtimes, specs } from "./views.js"
import type { PlanHandlers, ToolHandlers } from "../types.js"

/** The eight tools this package owns. */
export const HANDLERS: ToolHandlers = { specs, runtimes, files, execution, run, cancel, upload, download }

/** The `runtime.create` and consumer `runtime.delete` plans; the enterprise delete and stop are package E's. */
export const PLAN_HANDLERS: PlanHandlers = plans
