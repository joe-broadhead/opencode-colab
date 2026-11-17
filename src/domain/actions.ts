/**
 * The tool and action names, in one place (design §6, §7.1, §7.2, §10). Tool ids are `colab_<tool>`; permission
 * actions are `colab.<tool>` (gws's dotted form). Every tool asserts its own action before any network call; every
 * provider read additionally asserts `colab.read` on `<account>:<operation>`; the source contract's probe asserts
 * `colab.probe`. Those two are declared in `jelly.tools` as permission-only, read-only entries. `colab.cleanup` is the
 * `/colab-cleanup` command's action: in the default-rules block, never in `jelly.tools`.
 *
 * Asserted must equal declared: test/unit/jelly.test.ts checks every action here against package.json `jelly.tools`,
 * and test/unit/registry.test.ts checks that each registered tool asserts exactly its action.
 *
 * This module imports nothing, so a script can load it with Node's type stripping.
 */

/** The package that builds a tool or a plan handler (docs/v1-design.md, File ownership). */
export type Owner = "Day0" | "A" | "B" | "C" | "D" | "E" | "F" | "G"

/** Design §6's class column. `readOnly` is `class === "read"`. */
export type ToolClass = "read" | "write" | "export" | "destructive"

export interface ToolEntry {
  /** The id without the namespace: the model sees `colab_<name>`, the tools RPC method is `<name>`. */
  readonly name: string
  readonly class: ToolClass
  readonly owner: Owner
  /** Reads are Code Mode tools and tools RPC methods; changes are direct tools and never RPC methods (D18). */
  readonly codemode: boolean
  /** True for the two source-contract tools whose input the source contract defines. */
  readonly source?: true
}

const read = (name: string, owner: Owner, extra: Partial<ToolEntry> = {}): ToolEntry => ({ name, class: "read", owner, codemode: true, ...extra })
const change = (name: string, cls: Exclude<ToolClass, "read">, owner: Owner): ToolEntry => ({ name, class: cls, owner, codemode: false })

/** The twenty tools: twelve reads, eight changes, in design §6's order. */
export const TOOLS: readonly ToolEntry[] = [
  read("status", "F"),
  read("specs", "D"),
  read("runtimes", "D"),
  read("find", "C"),
  read("notebook", "C"),
  read("files", "D"),
  read("execution", "D"),
  read("jobs", "E"),
  read("schedules", "E"),
  read("plan", "Day0"),
  read("events_list", "G", { source: true }),
  read("runtimes_read", "G", { source: true }),
  change("edit", "write", "C"),
  change("run", "write", "D"),
  change("cancel", "write", "D"),
  change("upload", "write", "D"),
  change("download", "export", "D"),
  change("pause", "write", "E"),
  change("write", "write", "Day0"),
  change("delete", "destructive", "Day0"),
]

export const NAMESPACE_PREFIX = "colab"
export const toolId = (name: string) => `${NAMESPACE_PREFIX}_${name}`
export const actionOf = (name: string) => `${NAMESPACE_PREFIX}.${name}`

/** Every provider read (a Google or Jupyter read inside a read tool) asserts this on `<account>:<operation>`. */
export const READ_ACTION = "colab.read"
/** The source contract's probe: names the signed-in account, reads no content. */
export const PROBE_ACTION = "colab.probe"
/** Declared in `jelly.tools` with no tool of their own: read-only, `effect: "allow"`. */
export const PERMISSION_ONLY: readonly { readonly action: string; readonly note: string }[] = [
  { action: READ_ACTION, note: "The provider reads every read tool makes" },
  { action: PROBE_ACTION, note: "Names the signed-in account for sources; reads no content" },
]
/** `/colab-cleanup`'s action (design §8.5). Not a tool, so not declared in jelly; the default rules ask for it. */
export const CLEANUP_ACTION = "colab.cleanup"
/** A later tool in the namespace gets this rule's effect: a change's. */
export const NAMESPACE_ACTION = "colab.*"

export const TOOL_ACTIONS: readonly string[] = TOOLS.map((tool) => actionOf(tool.name))
export const READ_TOOL_ACTIONS: readonly string[] = TOOLS.filter((tool) => tool.class === "read").map((tool) => actionOf(tool.name))
export const CHANGE_TOOL_ACTIONS: readonly string[] = TOOLS.filter((tool) => tool.class !== "read").map((tool) => actionOf(tool.name))
/** Every action the plugin can assert: the 20 tool actions, `colab.read`, `colab.probe` and `colab.cleanup`. */
export const ASSERTABLE_ACTIONS: readonly string[] = [...TOOL_ACTIONS, READ_ACTION, PROBE_ACTION, CLEANUP_ACTION]
/** Every action declared in jelly.tools: the 20 tool actions and the two permission-only reads. */
export const DECLARED_ACTIONS: readonly string[] = [...TOOL_ACTIONS, ...PERMISSION_ONLY.map((entry) => entry.action)]

export function toolEntry(name: string): ToolEntry {
  const found = TOOLS.find((tool) => tool.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

// ── Operations (design §10) ─────────────────────────────────────────────
// Resources are `<account>` for a tool's own read assert, `<account>:<operation>` for changes and provider reads, and
// also `<account>:runtime:<id>` for runtime-scoped calls, so a person's rule (`deny colab.run on work:runtime:*`)
// fences. Operations are REST method ids, plus `jupyter.*` for the runtime protocol and `notebook.local.edit`.

export const OPERATIONS = {
  // Colab API v1beta, discovery revision 20261115.
  runtimesList: "colaboratory.runtimes.list",
  runtimesGet: "colaboratory.runtimes.get",
  runtimesCreate: "colaboratory.runtimes.create",
  runtimesDelete: "colaboratory.runtimes.delete",
  runtimeSpecsList: "colaboratory.runtimespecs.list",
  subscriptionGet: "colaboratory.getSubscription",
  // Vertex AI (Agent Platform). TODO(E): confirm each id against the pinned discovery document.
  jobsList: "aiplatform.projects.locations.notebookExecutionJobs.list",
  jobsGet: "aiplatform.projects.locations.notebookExecutionJobs.get",
  jobsCreate: "aiplatform.projects.locations.notebookExecutionJobs.create",
  jobsDelete: "aiplatform.projects.locations.notebookExecutionJobs.delete",
  jobOperationsCancel: "aiplatform.projects.locations.notebookExecutionJobs.operations.cancel",
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

/** A read operation's last segment starts with a read verb; a test holds every read operation to it. */
export const READ_VERBS = ["get", "list"] as const
export const isReadOperation = (operation: string) => READ_VERBS.some((verb) => (operation.split(".").at(-1) ?? "").startsWith(verb))

export const accountResource = (account: string) => account
export const operationResource = (account: string, operation: string) => `${account}:${operation}`
export const runtimeResource = (account: string, runtime: string) => `${account}:runtime:${runtime}`

// ── Plans (design §7.2) ────────────────────────────────────────────────

export type Backend = "colab" | "enterprise"
export type PlanCategory = "write" | "delete"

export interface PlanHandlerEntry {
  readonly owner: Owner
  /** The REST method the commit calls: the commit asserts `colab.<category>` on `<account>:<operation>`. */
  readonly operation: Operation
}

export interface PlanActionEntry {
  readonly category: PlanCategory
  /** The handler for each backend the action exists on; any other backend answers ACTION_UNSUPPORTED. */
  readonly backends: Partial<Record<Backend, PlanHandlerEntry>>
}

export const PLAN_ACTIONS = {
  "runtime.create": { category: "write", backends: { colab: { owner: "D", operation: OPERATIONS.runtimesCreate } } },
  "runtime.stop": { category: "write", backends: { enterprise: { owner: "E", operation: OPERATIONS.notebookRuntimesStop } } },
  "runtime.delete": {
    category: "delete",
    backends: { colab: { owner: "D", operation: OPERATIONS.runtimesDelete }, enterprise: { owner: "E", operation: OPERATIONS.notebookRuntimesDelete } },
  },
  "job.create": { category: "write", backends: { enterprise: { owner: "E", operation: OPERATIONS.jobsCreate } } },
  "job.delete": { category: "delete", backends: { enterprise: { owner: "E", operation: OPERATIONS.jobsDelete } } },
  "schedule.create": { category: "write", backends: { enterprise: { owner: "E", operation: OPERATIONS.schedulesCreate } } },
  "schedule.update": { category: "write", backends: { enterprise: { owner: "E", operation: OPERATIONS.schedulesPatch } } },
  "schedule.resume": { category: "write", backends: { enterprise: { owner: "E", operation: OPERATIONS.schedulesResume } } },
  "schedule.delete": { category: "delete", backends: { enterprise: { owner: "E", operation: OPERATIONS.schedulesDelete } } },
  "drive.create": { category: "write", backends: { colab: { owner: "C", operation: OPERATIONS.driveFilesCreate }, enterprise: { owner: "C", operation: OPERATIONS.driveFilesCreate } } },
  "drive.update": { category: "write", backends: { colab: { owner: "C", operation: OPERATIONS.driveFilesUpdate }, enterprise: { owner: "C", operation: OPERATIONS.driveFilesUpdate } } },
  "drive.trash": { category: "delete", backends: { colab: { owner: "C", operation: OPERATIONS.driveFilesUpdate }, enterprise: { owner: "C", operation: OPERATIONS.driveFilesUpdate } } },
} as const satisfies Record<string, PlanActionEntry>

export type PlanAction = keyof typeof PLAN_ACTIONS
export const PLAN_ACTION_NAMES = Object.keys(PLAN_ACTIONS) as PlanAction[]

/** Asked-for actions the plugin never plans (design §3, §7.1 last row), with the code each answers. */
export const REFUSED_PLAN_ACTIONS = {
  share: "SHARE_UNSUPPORTED",
  "drive.share": "SHARE_UNSUPPORTED",
  "iam.set": "ACTION_UNSUPPORTED",
  "template.create": "ACTION_UNSUPPORTED",
  "template.setDefault": "ACTION_UNSUPPORTED",
  "runtime.start": "ACTION_UNSUPPORTED",
} as const

/** The commit tool for each category: a write plan commits with colab_write, a delete plan with colab_delete. */
export const COMMIT_TOOL: Readonly<Record<PlanCategory, string>> = { write: "write", delete: "delete" }

// ── What counts as a change (design §7.1) ───────────────────────────────

export type ChangeKind = "read" | "change" | "export" | "destructive" | "refused"

export interface ChangeRow {
  readonly what: string
  readonly kind: ChangeKind
  /** The tool that does it, or `plan:<action>` for a plan, or `refused:<code>`. */
  readonly path: string
}

/** One row per line of design §7.1; a test maps every row to exactly one tool or plan action and its category. */
export const CHANGE_TABLE: readonly ChangeRow[] = [
  { what: "Read notebooks, outputs, runtimes, specs, jobs, schedules, runtime files", kind: "read", path: "read tools" },
  { what: "Edit or create a local notebook", kind: "change", path: "edit" },
  { what: "Run code or cells on a runtime of the plugin's own", kind: "change", path: "run" },
  { what: "Install packages", kind: "change", path: "run" },
  { what: "Upload a local file to a runtime of the plugin's own", kind: "change", path: "upload" },
  { what: "Download to the workspace", kind: "export", path: "download" },
  { what: "Create a consumer runtime", kind: "change", path: "plan:runtime.create" },
  { what: "Create an Enterprise execution job", kind: "change", path: "plan:job.create" },
  { what: "Create a schedule", kind: "change", path: "plan:schedule.create" },
  { what: "Update a schedule", kind: "change", path: "plan:schedule.update" },
  { what: "Resume a schedule", kind: "change", path: "plan:schedule.resume" },
  { what: "Push a new notebook to Drive", kind: "change", path: "plan:drive.create" },
  { what: "Push a new revision to Drive", kind: "change", path: "plan:drive.update" },
  { what: "Stop an Enterprise runtime (kernel state lost, disk kept)", kind: "change", path: "plan:runtime.stop" },
  { what: "Pause a schedule", kind: "change", path: "pause" },
  { what: "Interrupt a run", kind: "change", path: "cancel" },
  { what: "Release a consumer runtime, or delete an Enterprise runtime", kind: "destructive", path: "plan:runtime.delete" },
  { what: "Delete a job record", kind: "destructive", path: "plan:job.delete" },
  { what: "Delete a schedule", kind: "destructive", path: "plan:schedule.delete" },
  { what: "Trash a Drive notebook", kind: "destructive", path: "plan:drive.trash" },
  { what: "Run on a runtime not the plugin's own", kind: "refused", path: "refused:RUNTIME_NOT_OURS" },
  { what: "Share", kind: "refused", path: "refused:SHARE_UNSUPPORTED" },
  { what: "IAM, template create or setDefault, Enterprise runtime create or start", kind: "refused", path: "refused:ACTION_UNSUPPORTED" },
]

// ── colab_run asks once (review round 3, LOW 4) ─────────────────────────

/**
 * `colab_run` asserts `colab.run` exactly once per call, on every resource the call reaches: the execute operation and
 * the runtime. The pre-run and post-run credential probes, the watchdog's start and cancel requests and the session it
 * opens all run under that one assertion: none asserts again, so a person at `ask-changes` sees one ask per run, and
 * that ask carries the code preview (design §7.3).
 */
export const runResources = (account: string, runtime: string): string[] => [operationResource(account, OPERATIONS.kernelsExecute), runtimeResource(account, runtime)]
