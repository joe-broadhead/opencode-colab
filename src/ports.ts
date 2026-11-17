/**
 * The ports: every boundary a package builds against, so packages A–G build in parallel without editing each other's
 * files (docs/v1-design.md, File ownership). Types only. Each port has a fake in test/fakes/, and the tools receive
 * all of them through `Deps` (src/deps.ts), never by importing another package's module.
 *
 * External ports (the network): ColabApi, VertexApi, DriveApi, GcsApi, RuntimeProtocol; and Auth for credentials.
 * Local ports: Ledger, PlanStorePort, RunEvents, Clock.
 * Seams between packages: AgentOnlyCheck (B), Release (F), EnterpriseRuns (E), DriveSync (C).
 *
 * Every method takes an AbortSignal and honours it. Every failure is a ColabError (src/domain/errors.ts) with a code
 * from the table; a port never puts a token, the runtime URL, notebook text or Google's raw text in a message.
 */
import type { Access } from "./constants.js"
import type { Backend, Operation, PlanAction, PlanCategory } from "./domain/actions.js"
import type { ErrorCode, WarningCode } from "./domain/errors.js"

// ── Accounts and auth (package A) ───────────────────────────────────────

export interface AccountConfig {
  readonly alias: string
  readonly backend: Backend
  readonly mode: "interactive" | "adc" | "token"
  readonly access: "read" | "write"
  readonly drive: boolean
  readonly project?: string
  readonly region?: string
  readonly outputBucket?: string
  readonly serviceAccount?: string
  readonly runAsUser: boolean
  readonly tokenEnv?: string
  readonly impersonate?: string
}

export interface Identity {
  readonly email: string
  /** False for `token` mode, where nothing proves whose token it is. */
  readonly verified: boolean
}

/**
 * Credentials for one account. `token` decides AUTH_SCOPE_MISSING locally (as gws): it never calls Google with a token
 * that lacks a scope. An `invalid_grant` with a reauth reason is AUTH_REQUIRED with reason `session-control`.
 */
export interface Auth {
  token(account: string, scopes: readonly string[], signal: AbortSignal): Promise<string>
  identity(account: string, signal: AbortSignal): Promise<Identity | undefined>
  /** The scopes the stored grant holds, without a network call; empty when not signed in. */
  scopes(account: string): Promise<readonly string[]>
}

// ── Colab API v1beta (package B) ────────────────────────────────────────

export interface RuntimeSpecKey {
  readonly variant: "VARIANT_CPU" | "VARIANT_GPU" | "VARIANT_TPU"
  readonly shape: "SHAPE_STANDARD" | "SHAPE_HIGHMEM"
  readonly accelerator: string
}

export interface ColabRuntime {
  /** `runtimes/<id>`. */
  readonly name: string
  readonly spec: RuntimeSpecKey
  readonly version?: string
}

/**
 * The runtime's Jupyter server: the URL and the proxy token are credentials. Never logged or returned; refreshed 5
 * minutes before `expireTime`; the header is sent only when `url` is https on an allowed Google host (L2).
 */
export interface ConnectionInfo {
  readonly url: string
  readonly token: string
  readonly expireTime: string
}

export type SubscriptionTier = "SUBSCRIPTION_TIER_FREE" | "SUBSCRIPTION_TIER_PRO" | "SUBSCRIPTION_TIER_PRO_PLUS" | "SUBSCRIPTION_TIER_UNSPECIFIED"

export interface ColabApi {
  listRuntimeSpecs(account: string, signal: AbortSignal): Promise<readonly { readonly key: RuntimeSpecKey; readonly eligible: boolean }[]>
  getSubscription(account: string, signal: AbortSignal): Promise<SubscriptionTier>
  /** Every runtime assigned to the person, not only the plugin's own. */
  listRuntimes(account: string, signal: AbortSignal): Promise<readonly ColabRuntime[]>
  getRuntime(account: string, runtimeId: string, signal: AbortSignal): Promise<{ readonly runtime: ColabRuntime; readonly connection?: ConnectionInfo } | undefined>
  /**
   * Waits on the LRO up to `waitMs`. `runtimeId` is the client-chosen `oc-<ulid>` in lowercase (RFC-1034: the API takes
   * lowercase letters, digits and hyphens); `requestId` is a UUID4, so a retry joins the first create.
   */
  createRuntime(account: string, input: { readonly runtimeId: string; readonly spec: RuntimeSpecKey; readonly requestId: string; readonly waitMs: number }, signal: AbortSignal): Promise<{ readonly done: boolean; readonly runtime?: ColabRuntime; readonly operation: string }>
  deleteRuntime(account: string, runtimeId: string, signal: AbortSignal): Promise<void>
}

// ── The runtime protocol: Jupyter on a Colab runtime (package B) ────────

export interface KernelInfo {
  readonly id: string
  readonly name: string
  readonly executionState: "idle" | "busy" | "starting" | "dead" | string
  readonly lastActivity: string
  readonly connections: number
}

export interface SessionInfo {
  readonly id: string
  /** `oc-<nonce>-<name>` for the plugin's own sessions; anything else is foreign. */
  readonly name: string
  readonly path: string
  readonly kernelId: string
}

export interface ContentEntry {
  readonly path: string
  readonly type: "file" | "directory" | "notebook"
  readonly size?: number
  readonly lastModified?: string
}

/** One iopub message as the plugin keeps it: its type and content, by the request it answers. */
export interface IopubMessage {
  readonly parentMsgId: string
  readonly msgType: string
  readonly content: Readonly<Record<string, unknown>>
}

export interface ExecuteOptions {
  /** Always false: no stdin channel, so gcloud's prompt fallback raises (design §7.4 step 5). */
  readonly allowStdin: false
  readonly silent: boolean
  readonly storeHistory: boolean
}

export interface KernelSession {
  readonly session: SessionInfo
  /**
   * Sends one `execute_request` and yields its iopub messages until `status: idle`. Every `colab_request` is answered
   * at once with a `colab_reply` carrying an error, in the same tick, and still yielded so capture can report
   * COLAB_UI_API.
   */
  execute(code: string, options: ExecuteOptions, signal: AbortSignal): AsyncIterable<IopubMessage>
  interrupt(signal: AbortSignal): Promise<void>
  restart(signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

export interface RuntimeTarget {
  readonly account: string
  readonly runtimeId: string
}

/**
 * The Jupyter Server REST API and the kernel WebSocket on one runtime, through `connectionInfo.url` with the
 * `X-Colab-Runtime-Proxy-Token` header (design §1, H6). Package B builds it; the probe and the watchdog run through it.
 */
export interface RuntimeProtocol {
  /** Opens or reuses the kernel session `name` (already nonce-prefixed by the caller). */
  openSession(target: RuntimeTarget, input: { readonly name: string; readonly path: string }, signal: AbortSignal): Promise<KernelSession>
  kernels(target: RuntimeTarget, signal: AbortSignal): Promise<readonly KernelInfo[]>
  sessions(target: RuntimeTarget, signal: AbortSignal): Promise<readonly SessionInfo[]>
  files: {
    list(target: RuntimeTarget, path: string, signal: AbortSignal): Promise<readonly ContentEntry[] | undefined>
    /** `GET {url}/files/{path}` with Range; streamed to a temp file by the caller. */
    read(target: RuntimeTarget, path: string, signal: AbortSignal): Promise<AsyncIterable<Uint8Array>>
    /** `PUT /api/contents` in ≤ 50 MB chunks. */
    write(target: RuntimeTarget, path: string, bytes: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<{ readonly bytes: number }>
  }
}

// ── The agent-only check (package B) ────────────────────────────────────

/**
 * Stored with a runtime of the plugin's own at creation, before any agent code (design §7.4 step 2).
 *
 * The probe kernel (review round 3, LOW 2 and 3): it is started here, before any agent code, with its own start budget
 * (`probeKernelStartSeconds`, 60 by default, because a fresh ipykernel on Colab imports google.colab and its stack),
 * and never restarted. Its kernel id and execution count are recorded: if the id changes, the kernel dies, or the
 * count goes backwards, the next probe answers RUNTIME_UNVERIFIED and the runtime is tainted. `probeTimeoutSeconds` (5)
 * bounds each probe after that. L2 records the start time, the round-trip time and the probe kernel's RAM.
 */
export interface Calibration {
  /** REST can list `content/.config` (`allow_hidden` on); false means REST checks are blind on this runtime. */
  readonly hiddenPathsVisible: boolean
  /** Each kernel's `connections` with only the plugin attached, so a proxy's own connection is not another client. */
  readonly baselineConnections: Readonly<Record<string, number>>
  readonly probeKernel: { readonly id: string; readonly executionCount: number; readonly startMs: number; readonly rttMs: number; readonly ramBytes?: number }
  /** The colabtools version the probe snippet is pinned to; the drift job flags a change. */
  readonly snippetVersion: string
  readonly at: string
}

/** The probe's booleans, never contents (design §7.4 step 3). */
export interface ProbeFindings {
  readonly mounts: boolean
  readonly credentialFiles: readonly string[]
  readonly ephemeralMarkers: readonly string[]
  /** Sessions whose name lacks the runtime's nonce. */
  readonly foreignSessions: number
  /** Kernels whose `connections` exceed the calibrated baseline plus the plugin's own sockets. */
  readonly extraConnections: number
}

export type ProbeVerdict =
  | { readonly ok: true; readonly findings: ProbeFindings; readonly at: string }
  | { readonly ok: false; readonly code: Extract<ErrorCode, "RUNTIME_HAS_CREDENTIALS" | "RUNTIME_SHARED" | "RUNTIME_UNVERIFIED">; readonly findings?: ProbeFindings; readonly at: string }

/**
 * What the check can and cannot see (design §7.4; review round 3, LOW 1 and 2):
 *
 * - The session nonce is not a secret. Session names, nonce included, are listed by `/api/sessions` and by Google's
 *   Colab MCP; a client that opens a session with the id of one of the plugin's own runs code in that kernel without
 *   a new session. A session without the nonce is foreign; a client using one of the plugin's own sessions is seen
 *   only by the `connections` check, and only while attached.
 * - The probe shares the runtime with the agent's code, which runs as root and may keep processes running after a
 *   run. It detects other clients' traces and accidents, not code written to hide from it. Only a release or a kernel
 *   restart ends such background processes; nothing else does.
 *
 * The probe never runs in the agent's session; it runs under the caller's one `colab.run` assertion (actions.ts,
 * runResources) and asserts nothing itself.
 */
export interface AgentOnlyCheck {
  calibrate(target: RuntimeTarget, nonce: string, signal: AbortSignal): Promise<Calibration>
  /** Cached 30 s per runtime; `fresh` skips the cache (after a run). A finding taints the runtime in the ledger. */
  probe(target: RuntimeTarget, input: { readonly nonce: string; readonly calibration: Calibration; readonly fresh: boolean }, signal: AbortSignal): Promise<ProbeVerdict>
}

// ── Vertex AI / Colab Enterprise (package E) ────────────────────────────

export interface EnterpriseJob {
  readonly name: string
  readonly displayName: string
  readonly state: string
  readonly createTime?: string
  readonly endTime?: string
  readonly gcsOutputUri?: string
  readonly schedule?: string
  readonly error?: string
}

export interface EnterpriseSchedule {
  readonly name: string
  readonly displayName: string
  readonly cron: string
  readonly state: string
  readonly maxRunCount?: number
  readonly endTime?: string
  readonly startedRunCount?: number
}

export interface EnterpriseRuntime {
  readonly name: string
  readonly state: string
  readonly machineType?: string
  readonly accelerator?: string
  readonly template?: string
  readonly idleShutdownMinutes?: number | null
  readonly euc?: boolean
}

export interface VertexApi {
  listJobs(account: string, input: { readonly filter?: string; readonly pageSize?: number }, signal: AbortSignal): Promise<readonly EnterpriseJob[]>
  getJob(account: string, name: string, signal: AbortSignal): Promise<EnterpriseJob | undefined>
  /** Client-chosen `notebookExecutionJobId`; ALREADY_EXISTS joins the first create. Returns the create LRO's name. */
  createJob(account: string, input: { readonly jobId: string; readonly body: Readonly<Record<string, unknown>> }, signal: AbortSignal): Promise<{ readonly job: EnterpriseJob; readonly operation: string }>
  deleteJob(account: string, name: string, signal: AbortSignal): Promise<void>
  cancelOperation(account: string, operation: string, signal: AbortSignal): Promise<void>
  listSchedules(account: string, signal: AbortSignal): Promise<readonly EnterpriseSchedule[]>
  getSchedule(account: string, name: string, signal: AbortSignal): Promise<EnterpriseSchedule | undefined>
  /** Never retried automatically: an uncertain answer is reconciled by listing on the plan's unique displayName. */
  createSchedule(account: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<EnterpriseSchedule>
  updateSchedule(account: string, name: string, body: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<EnterpriseSchedule>
  pauseSchedule(account: string, name: string, signal: AbortSignal): Promise<void>
  resumeSchedule(account: string, name: string, signal: AbortSignal): Promise<void>
  deleteSchedule(account: string, name: string, signal: AbortSignal): Promise<void>
  listRuntimes(account: string, signal: AbortSignal): Promise<readonly EnterpriseRuntime[]>
  stopRuntime(account: string, name: string, signal: AbortSignal): Promise<void>
  deleteRuntime(account: string, name: string, signal: AbortSignal): Promise<void>
  listTemplates(account: string, signal: AbortSignal): Promise<readonly Readonly<Record<string, unknown>>[]>
}

// ── Drive and GCS (packages C and E) ────────────────────────────────────

export interface DriveFile {
  readonly id: string
  readonly name: string
  readonly mimeType: string
  readonly headRevisionId?: string
  readonly modifiedTime?: string
  readonly ownedByMe?: boolean
  readonly lastModifyingUser?: string
}

export interface DriveApi {
  list(account: string, input: { readonly query?: string; readonly pageSize?: number }, signal: AbortSignal): Promise<readonly DriveFile[]>
  get(account: string, fileId: string, signal: AbortSignal): Promise<DriveFile | undefined>
  /** `alt=media`. */
  download(account: string, fileId: string, signal: AbortSignal): Promise<Uint8Array>
  create(account: string, input: { readonly name: string; readonly folder?: string; readonly bytes: Uint8Array; readonly mimeType: string }, signal: AbortSignal): Promise<DriveFile>
  update(account: string, fileId: string, input: { readonly bytes?: Uint8Array; readonly trashed?: boolean }, signal: AbortSignal): Promise<DriveFile>
  /** `revisions.update` with keepForever; false when the file already has 200 kept revisions (REVISION_PIN_SKIPPED). */
  keepRevision(account: string, fileId: string, revisionId: string, signal: AbortSignal): Promise<boolean>
}

export interface GcsApi {
  list(account: string, prefix: string, signal: AbortSignal): Promise<readonly { readonly uri: string; readonly size: number; readonly updated?: string }[]>
  read(account: string, uri: string, signal: AbortSignal): Promise<Uint8Array>
}

// ── The ledger (Day 0) ──────────────────────────────────────────────────

export interface Taint {
  readonly code: "RUNTIME_HAS_CREDENTIALS" | "RUNTIME_SHARED" | "RUNTIME_UNVERIFIED"
  readonly at: string
}

/** A consumer runtime of the plugin's own. The ledger is the truth; the `oc-` id is a display hint. */
export interface RuntimeRecord {
  readonly id: string
  readonly account: string
  readonly backend: "colab"
  readonly spec: RuntimeSpecKey
  readonly createdAt: string
  /** Per-runtime, kept only in the ledger: tells the plugin's sessions from others' (not a secret; see AgentOnlyCheck). */
  readonly nonce: string
  readonly keep: readonly string[]
  readonly lease: { readonly releaseAfterIdleMinutes: number; readonly maxHours: number }
  readonly state: "creating" | "ready" | "released" | "gone"
  readonly calibration?: Calibration
  readonly tainted?: Taint
  readonly releasedAt?: string
}

/** One run or Enterprise job. Never cell text. */
export interface RunRecord {
  readonly runId: string
  readonly account: string
  readonly backend: Backend
  readonly runtime?: string
  readonly job?: string
  readonly notebook?: string
  readonly cellIds: readonly string[]
  readonly spec?: string
  readonly startedAt: string
  readonly endedAt?: string
  readonly state: "running" | "ok" | "error" | "cancelled" | "timeout" | "detached" | "failed"
  readonly outputPaths: readonly string[]
  readonly errorCode?: ErrorCode
  /** For the colab.runs title: plugin words only, never notebook text. */
  readonly summary?: string
}

export interface LedgerEvent {
  /** Monotonic across the ledger's life; the colab.runs cursor. */
  readonly seq: number
  readonly at: string
  readonly type: "run.finished" | "runtime.created" | "runtime.released" | "runtime.tainted" | "runtime.gone"
  readonly id: string
  readonly account: string
}

/**
 * `$XDG_STATE_HOME/opencode-colab/ledger/`: one JSON file per runtime and per run, written copy-on-write (temp, then
 * rename), plus `events.jsonl`, under a cross-process lock, pruned after `ledgerDays` (src/ledger/store.ts).
 */
export interface Ledger {
  putRuntime(record: RuntimeRecord): Promise<void>
  getRuntime(id: string): Promise<RuntimeRecord | undefined>
  listRuntimes(filter?: { readonly account?: string; readonly live?: boolean }): Promise<readonly RuntimeRecord[]>
  /** Sets the taint once; a tainted runtime stays tainted. Appends `runtime.tainted`. */
  taint(id: string, taint: Taint): Promise<RuntimeRecord | undefined>
  putRun(record: RunRecord): Promise<void>
  getRun(runId: string): Promise<RunRecord | undefined>
  listRuns(filter?: { readonly account?: string; readonly since?: string; readonly state?: RunRecord["state"] }): Promise<readonly RunRecord[]>
  append(event: Omit<LedgerEvent, "seq" | "at">): Promise<LedgerEvent>
  /** Events after `seq`, oldest first; `expired` when `seq` is older than the oldest kept event. */
  eventsSince(seq: number, limit: number): Promise<{ readonly events: readonly LedgerEvent[]; readonly expired: boolean; readonly oldest: number }>
  /** Deletes records and events older than `ledgerDays`; returns how many records went. */
  prune(now: Date): Promise<number>
}

// ── Plans (Day 0) ───────────────────────────────────────────────────────

export interface PlanBinding {
  readonly sessionId: string
  readonly agentId: string
}

export interface StoredPlan {
  readonly id: string
  readonly action: PlanAction
  readonly category: PlanCategory
  readonly account: string
  readonly backend: Backend
  readonly operation: Operation
  readonly sessionId: string
  readonly agentId: string
  /** What the person sees; secret-screened, no token or runtime URL. */
  readonly preview: Readonly<Record<string, unknown>>
  /** What the handler's commit needs; never shown. */
  readonly payload: Readonly<Record<string, unknown>>
  /** What commit re-reads and compares: a difference is PLAN_CHANGED. */
  readonly fingerprint: Readonly<Record<string, unknown>>
  readonly createdAt: number
  readonly expiresAt: number
  state: "ready" | "committing" | "consumed" | "expired"
}

export interface PlanStorePort {
  create(input: Omit<StoredPlan, "id" | "state" | "createdAt" | "expiresAt">): StoredPlan
  check(id: string, binding: PlanBinding & { readonly category: PlanCategory }): StoredPlan
  acquire(id: string, binding: PlanBinding & { readonly category: PlanCategory }): StoredPlan
  complete(id: string): void
  release(id: string): void
}

// ── Run events, the clock (Day 0) ───────────────────────────────────────

export type RunEvent =
  | { readonly type: "started"; readonly runId: string; readonly account: string }
  | { readonly type: "cell"; readonly runId: string; readonly cellId: string; readonly state: "ok" | "error" | "running" }
  | { readonly type: "finished"; readonly runId: string; readonly state: RunRecord["state"] }

/** Package D publishes; F (status, hooks) and G (colab.runs) subscribe. */
export interface RunEvents {
  publish(event: RunEvent): void
  subscribe(listener: (event: RunEvent) => void): () => void
}

export interface Clock {
  now(): Date
}

// ── Seams between packages ──────────────────────────────────────────────

/** Package F: the one release function (harvest `keep`, then delete), shared by automation and the delete plan. */
export interface Release {
  release(runtime: RuntimeRecord, input: { readonly reason: "plan" | "idle" | "lifetime"; readonly force: boolean }, signal: AbortSignal): Promise<{ readonly harvested: readonly string[]; readonly released: boolean; readonly warnings: readonly WarningCode[] }>
}

/** Package E: the Enterprise branches of tools package D owns (colab_execution, colab_cancel, colab_download). */
export interface EnterpriseRuns {
  execution(account: string, input: { readonly job: string; readonly wait?: number; readonly cell?: string; readonly full?: boolean }, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  cancel(account: string, job: string, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
  downloadGcs(account: string, input: { readonly gcs: string; readonly to?: string; readonly overwrite?: boolean }, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
}

/** Package C: the Drive branch of colab_download (pull, with the sync record and LOCAL_CHANGED). */
export interface DriveSync {
  pull(account: string, input: { readonly drive: string; readonly to?: string; readonly overwrite?: boolean }, signal: AbortSignal): Promise<Readonly<Record<string, unknown>>>
}

// ── The permission bridge (Day 0) ───────────────────────────────────────

export interface PermissionRequest {
  readonly sessionID: string
  readonly agent: string
  readonly action: string
  readonly resources: readonly string[]
  /** Absent for colab.delete: a delete never offers Always. */
  readonly save?: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
  readonly source: { readonly type: "tool"; readonly messageID: string; readonly id: string }
}

/** `ctx.permission.assert`: resolves when allowed, rejects on deny or a declined ask. */
export type Assert = (request: PermissionRequest) => Promise<void>

/** The access level, as the default rules and automation consent read it. */
export type AccessLevel = Access
