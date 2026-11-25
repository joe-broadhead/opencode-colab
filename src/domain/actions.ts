/**
 * The provider operations, the plan actions and the resource strings the manifest declares.
 *
 * Operations are dotted provider method ids (`colaboratory.runtimes.list`, `drive.files.get`); a method declares the
 * operations it may assert, and the contract's register asserts them on `<alias>:<operation>`.
 */

export type Backend = "colab" | "enterprise"
export type PlanCategory = "write" | "delete"

export const OPERATIONS = {
  // Colab API v1beta.
  runtimesList: "colaboratory.runtimes.list",
  runtimesGet: "colaboratory.runtimes.get",
  runtimesCreate: "colaboratory.runtimes.create",
  runtimesDelete: "colaboratory.runtimes.delete",
  runtimeSpecsList: "colaboratory.runtimespecs.list",
  subscriptionGet: "colaboratory.getSubscription",
  // Vertex AI.
  jobsList: "aiplatform.projects.locations.notebookExecutionJobs.list",
  jobsGet: "aiplatform.projects.locations.notebookExecutionJobs.get",
  jobsCreate: "aiplatform.projects.locations.notebookExecutionJobs.create",
  jobsDelete: "aiplatform.projects.locations.notebookExecutionJobs.delete",
  jobOperationsCancel: "aiplatform.projects.locations.notebookExecutionJobs.operations.cancel",
  jobOperationsList: "aiplatform.projects.locations.notebookExecutionJobs.operations.list",
  schedulesList: "aiplatform.projects.locations.schedules.list",
  schedulesGet: "aiplatform.projects.locations.schedules.get",
  schedulesCreate: "aiplatform.projects.locations.schedules.create",
  schedulesPatch: "aiplatform.projects.locations.schedules.patch",
  schedulesPause: "aiplatform.projects.locations.schedules.pause",
  schedulesResume: "aiplatform.projects.locations.schedules.resume",
  schedulesDelete: "aiplatform.projects.locations.schedules.delete",
  notebookRuntimesList: "aiplatform.projects.locations.notebookRuntimes.list",
  notebookRuntimesGet: "aiplatform.projects.locations.notebookRuntimes.get",
  notebookRuntimesStop: "aiplatform.projects.locations.notebookRuntimes.stop",
  notebookRuntimesDelete: "aiplatform.projects.locations.notebookRuntimes.delete",
  templatesList: "aiplatform.projects.locations.notebookRuntimeTemplates.list",
  // Drive API v3 and Cloud Storage JSON API.
  driveFilesList: "drive.files.list",
  driveFilesGet: "drive.files.get",
  driveFilesCreate: "drive.files.create",
  driveFilesUpdate: "drive.files.update",
  driveRevisionsUpdate: "drive.revisions.update",
  driveRevisionsList: "drive.revisions.list",
  driveFilesGenerateIds: "drive.files.generateIds",
  storageObjectsList: "storage.objects.list",
  storageObjectsGet: "storage.objects.get",
  // The runtime's Jupyter server.
  kernelsList: "jupyter.kernels.list",
  sessionsList: "jupyter.sessions.list",
  contentsList: "jupyter.contents.list",
  contentsGet: "jupyter.contents.get",
  contentsSave: "jupyter.contents.save",
  kernelsExecute: "jupyter.kernels.execute",
  kernelsInterrupt: "jupyter.kernels.interrupt",
  // Local, and the plugin's own ledger (the colab.runs source).
  localEdit: "notebook.local.edit",
  ledgerList: "colab.ledger.list",
} as const

export type Operation = (typeof OPERATIONS)[keyof typeof OPERATIONS]

/** The declared read the doctor's credential check and the source probe assert. */
export const PROBE_ACTION = "colab.probe"
export const accountResource = (account: string) => account
export const operationResource = (account: string, operation: string) => `${account}:${operation}`
export const runtimeResource = (account: string, runtime: string) => `${account}:runtime:${runtime}`
/** `colab_run` asserts once per call, on the execute operation and the runtime. */
export const runResources = (account: string, runtime: string): string[] => [operationResource(account, OPERATIONS.kernelsExecute), runtimeResource(account, runtime)]

/** The operation a plan action's commit asserts. */
export interface PlanHandlerEntry {
  readonly operation: Operation
}

export interface PlanActionEntry {
  readonly category: PlanCategory
  readonly backends: Partial<Record<Backend, PlanHandlerEntry>>
}

export const PLAN_ACTIONS = {
  "runtime.create": { category: "write", backends: { colab: { operation: OPERATIONS.runtimesCreate } } },
  "runtime.stop": { category: "write", backends: { enterprise: { operation: OPERATIONS.notebookRuntimesStop } } },
  "runtime.delete": {
    category: "delete",
    backends: { colab: { operation: OPERATIONS.runtimesDelete }, enterprise: { operation: OPERATIONS.notebookRuntimesDelete } },
  },
  "job.create": { category: "write", backends: { enterprise: { operation: OPERATIONS.jobsCreate } } },
  "job.delete": { category: "delete", backends: { enterprise: { operation: OPERATIONS.jobsDelete } } },
  "schedule.create": { category: "write", backends: { enterprise: { operation: OPERATIONS.schedulesCreate } } },
  "schedule.update": { category: "write", backends: { enterprise: { operation: OPERATIONS.schedulesPatch } } },
  "schedule.resume": { category: "write", backends: { enterprise: { operation: OPERATIONS.schedulesResume } } },
  "schedule.delete": { category: "delete", backends: { enterprise: { operation: OPERATIONS.schedulesDelete } } },
  "drive.create": { category: "write", backends: { colab: { operation: OPERATIONS.driveFilesCreate }, enterprise: { operation: OPERATIONS.driveFilesCreate } } },
  "drive.update": { category: "write", backends: { colab: { operation: OPERATIONS.driveFilesUpdate }, enterprise: { operation: OPERATIONS.driveFilesUpdate } } },
  "drive.trash": { category: "delete", backends: { colab: { operation: OPERATIONS.driveFilesUpdate }, enterprise: { operation: OPERATIONS.driveFilesUpdate } } },
} as const satisfies Record<string, PlanActionEntry>

export type PlanAction = keyof typeof PLAN_ACTIONS
export const PLAN_ACTION_NAMES = Object.keys(PLAN_ACTIONS) as PlanAction[]

/** Asked-for actions the plugin never plans, with the code each answers. */
export const REFUSED_PLAN_ACTIONS = {
  share: "SHARE_UNSUPPORTED",
  "drive.share": "SHARE_UNSUPPORTED",
  "iam.set": "ACTION_UNSUPPORTED",
  "template.create": "ACTION_UNSUPPORTED",
  "template.setDefault": "ACTION_UNSUPPORTED",
  "runtime.start": "ACTION_UNSUPPORTED",
} as const

/** The commit method for each category. */
export const COMMIT_METHOD: Readonly<Record<PlanCategory, string>> = { write: "write", delete: "delete" }
