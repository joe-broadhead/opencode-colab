/**
 * In-memory fakes for every port in src/ports.ts, and a recording permission, so each package tests its handlers
 * without Google, a runtime or another package. This file is Day 0's and is not extended: a package that needs a
 * richer double (the loopback fakes of design §15.2) adds test/fakes/<package>-*.ts and subclasses or composes these
 * there (docs/v1-design.md, File ownership).
 *
 * Each fake keeps its state in plain fields a test can set and read, and records its calls.
 */
import { createHash, randomUUID } from "node:crypto"
import { PlanStore } from "../../src/domain/plans.js"
import { isFinal } from "../../src/ledger/store.js"
import { ColabError } from "../../src/domain/errors.js"
import type { Deps } from "../../src/deps.js"
import { createRunEvents } from "../../src/events.js"
import { loadOptions, type Options } from "../../src/options.js"
import { OPERATIONS } from "../../src/domain/actions.js"
import type {
  AgentOnlyCheck,
  Auth,
  Budget,
  Calibration,
  Clock,
  ColabApi,
  ColabRuntime,
  ContentEntry,
  DriveApi,
  DriveFile,
  DriveSync,
  EnterpriseJob,
  EnterpriseRuns,
  EnterpriseRuntime,
  EnterpriseSchedule,
  GcsApi,
  IopubMessage,
  KernelInfo,
  KernelSession,
  Ledger,
  LedgerEvent,
  NotebookStore,
  PermissionRequest,
  Prices,
  ProbeVerdict,
  ProviderRead,
  Release,
  RunRecord,
  RuntimeProtocol,
  RuntimeRecord,
  RuntimeSpecKey,
  SessionInfo,
  SubscriptionTier,
  Taint,
  VertexApi,
} from "../../src/ports.js"

export type Call = { readonly method: string; readonly args: readonly unknown[] }

/** A clock a test moves by hand. */
export class FakeClock implements Clock {
  constructor(public current = new Date("2026-11-17T09:00:00.000Z")) {}
  now() {
    return new Date(this.current)
  }
  advance(ms: number) {
    this.current = new Date(this.current.getTime() + ms)
  }
}

// ── Permission ──────────────────────────────────────────────────────────

/** Records every assert; `decide` throws to deny (default: allow everything). */
export class RecordingPermission {
  readonly requests: PermissionRequest[] = []
  decide: (request: PermissionRequest) => void = () => undefined
  readonly assert = async (request: PermissionRequest) => {
    this.requests.push(request)
    this.decide(request)
  }
  actions() {
    return this.requests.map((request) => request.action)
  }
  denyAll(message = "denied by the test's rules") {
    this.decide = () => {
      throw new Error(message)
    }
  }
}

// ── Auth ────────────────────────────────────────────────────────────────

export class FakeAuth implements Auth {
  readonly calls: Call[] = []
  /** Scopes held per account; an account absent here is not signed in. */
  grants = new Map<string, readonly string[]>()
  emails = new Map<string, string>()
  async token(account: string, scopes: readonly string[]) {
    this.calls.push({ method: "token", args: [account, scopes] })
    const held = this.grants.get(account)
    if (!held) throw new ColabError("AUTH_REQUIRED")
    const missing = scopes.filter((scope) => !held.includes(scope))
    if (missing.length) throw new ColabError("AUTH_SCOPE_MISSING", `The sign-in lacks ${missing.join(", ")}.`)
    return `fake-token-${account}`
  }
  async identity(account: string) {
    const email = this.emails.get(account)
    return email ? { email, verified: true } : undefined
  }
  async scopes(account: string) {
    return this.grants.get(account) ?? []
  }
}

// ── Colab API ───────────────────────────────────────────────────────────

export const CPU: RuntimeSpecKey = { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" }
export const T4: RuntimeSpecKey = { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" }

export class FakeColabApi implements ColabApi {
  readonly calls: Call[] = []
  specs: { key: RuntimeSpecKey; eligible: boolean }[] = [
    { key: CPU, eligible: true },
    { key: T4, eligible: true },
  ]
  tier: SubscriptionTier = "SUBSCRIPTION_TIER_PRO"
  runtimes = new Map<string, ColabRuntime>()
  /** requestId → runtimeId: a retried create joins the first. */
  readonly requests = new Map<string, string>()
  /** Set to make the next create fail with this code. */
  failNextCreate?: ColabError
  async listRuntimeSpecs(account: string) {
    this.calls.push({ method: "listRuntimeSpecs", args: [account] })
    return this.specs
  }
  async getSubscription(account: string) {
    this.calls.push({ method: "getSubscription", args: [account] })
    return this.tier
  }
  async listRuntimes(account: string) {
    this.calls.push({ method: "listRuntimes", args: [account] })
    return [...this.runtimes.values()]
  }
  async getRuntime(account: string, runtimeId: string) {
    this.calls.push({ method: "getRuntime", args: [account, runtimeId] })
    const runtime = this.runtimes.get(runtimeId)
    return runtime ? { runtime, connection: { url: `https://fake-runtime.invalid/${runtimeId}`, token: "fake-proxy-token", expireTime: "2026-11-17T10:00:00Z" } } : undefined
  }
  async createRuntime(account: string, input: { runtimeId: string; spec: RuntimeSpecKey; requestId: string; waitMs: number }) {
    this.calls.push({ method: "createRuntime", args: [account, input] })
    if (this.failNextCreate) {
      const error = this.failNextCreate
      this.failNextCreate = undefined
      throw error
    }
    const joined = this.requests.get(input.requestId)
    const id = joined ?? input.runtimeId
    if (!joined) {
      this.requests.set(input.requestId, id)
      this.runtimes.set(id, { name: `runtimes/${id}`, spec: input.spec })
    }
    return { done: true, runtime: this.runtimes.get(id)!, operation: `operations/${input.requestId}` }
  }
  async deleteRuntime(account: string, runtimeId: string) {
    this.calls.push({ method: "deleteRuntime", args: [account, runtimeId] })
    if (!this.runtimes.delete(runtimeId)) throw new ColabError("NOT_FOUND")
  }
}

// ── Runtime protocol ────────────────────────────────────────────────────

/** A scripted kernel: `respond` maps code to the iopub messages it yields (status idle is added). */
export class FakeKernelSession implements KernelSession {
  readonly executed: { code: string; allowStdin: false; silent: boolean }[] = []
  interrupts = 0
  restarts = 0
  /** Every watchdog call, in order: a number starts the bound, null cancels it. */
  readonly watchdogs: (number | null)[] = []
  closed = false
  constructor(
    readonly session: SessionInfo,
    private readonly respond: (code: string) => readonly Omit<IopubMessage, "parentMsgId">[],
  ) {}
  async *execute(code: string, options: { allowStdin: false; silent: boolean; storeHistory: boolean }) {
    this.executed.push({ code, allowStdin: options.allowStdin, silent: options.silent })
    const parentMsgId = randomUUID()
    for (const message of this.respond(code)) yield { parentMsgId, ...message }
    yield { parentMsgId, msgType: "status", content: { execution_state: "idle" } }
  }
  async interrupt() {
    this.interrupts++
  }
  async restart() {
    this.restarts++
  }
  async watchdog(seconds: number | null) {
    this.watchdogs.push(seconds)
  }
  async close() {
    this.closed = true
  }
}

export class FakeRuntimeProtocol implements RuntimeProtocol {
  readonly calls: Call[] = []
  kernels_ = new Map<string, KernelInfo[]>()
  sessions_ = new Map<string, SessionInfo[]>()
  /** runtimeId → path → bytes. */
  contents = new Map<string, Map<string, Uint8Array>>()
  /** runtimeId → the folders that exist. A write needs its parent, as Jupyter's contents API does. */
  readonly directories = new Map<string, Set<string>>()
  readonly opened: FakeKernelSession[] = []
  respond: (code: string) => readonly Omit<IopubMessage, "parentMsgId">[] = () => [{ msgType: "stream", content: { name: "stdout", text: "ok\n" } }]

  async openSession(target: { account: string; runtimeId: string }, input: { name: string; path: string }, _signal?: AbortSignal) {
    this.calls.push({ method: "openSession", args: [target, input] })
    const session: SessionInfo = { id: randomUUID(), name: input.name, path: input.path, kernelId: randomUUID() }
    this.sessions_.set(target.runtimeId, [...(this.sessions_.get(target.runtimeId) ?? []), session])
    const kernel = new FakeKernelSession(session, (code) => this.respond(code))
    this.opened.push(kernel)
    return kernel
  }
  async kernels(target: { runtimeId: string }) {
    return this.kernels_.get(target.runtimeId) ?? []
  }
  async sessions(target: { runtimeId: string }) {
    return this.sessions_.get(target.runtimeId) ?? []
  }
  /** The folders a runtime has, starting with the server root and Colab's /content. */
  folders(runtimeId: string): Set<string> {
    let set = this.directories.get(runtimeId)
    if (!set) {
      set = new Set(["/", "/content"])
      this.directories.set(runtimeId, set)
    }
    return set
  }
  readonly files = {
    list: async (target: { runtimeId: string }, path: string): Promise<readonly ContentEntry[] | undefined> => {
      const files = this.contents.get(target.runtimeId)
      if (!files) return undefined
      const prefix = path.endsWith("/") ? path : `${path}/`
      return [...files.entries()].filter(([name]) => name.startsWith(prefix)).map(([name, bytes]) => ({ path: name, type: "file" as const, size: bytes.length }))
    },
    /** Records each read with its range; a range slices as HTTP Range does (`end` inclusive). */
    reads: [] as { runtimeId: string; path: string; range?: { readonly start: number; readonly end?: number } }[],
    read: async (target: { runtimeId: string }, path: string, _signal?: AbortSignal, options: { readonly range?: { readonly start: number; readonly end?: number } } = {}) => {
      this.files.reads.push({ runtimeId: target.runtimeId, path, ...(options.range ? { range: options.range } : {}) })
      const bytes = this.contents.get(target.runtimeId)?.get(path)
      if (!bytes) throw new ColabError("NOT_FOUND")
      const range = options.range
      const slice = range ? bytes.subarray(range.start, range.end === undefined ? undefined : range.end + 1) : bytes
      return (async function* () {
        yield slice
      })()
    },
    mkdir: async (target: { runtimeId: string }, path: string) => {
      // Jupyter creates one directory per request and requires its parent; an existing folder is not an error.
      const parent = path.replace(/\/+$/, "").split("/").slice(0, -1).join("/") || "/"
      if (!this.folders(target.runtimeId).has(parent)) throw new ColabError("NOT_FOUND", "The folder's parent does not exist.")
      this.folders(target.runtimeId).add(path.replace(/\/+$/, ""))
    },
    write: async (target: { runtimeId: string }, path: string, chunks: AsyncIterable<Uint8Array>, _signal?: AbortSignal) => {
      const parent = path.split("/").slice(0, -1).join("/") || "/"
      if (!this.folders(target.runtimeId).has(parent)) throw new ColabError("NOT_FOUND", "A file write needs its parent folder, as Jupyter's contents API does.")
      const parts: Uint8Array[] = []
      for await (const chunk of chunks) parts.push(chunk)
      const bytes = Buffer.concat(parts)
      const files = this.contents.get(target.runtimeId) ?? new Map<string, Uint8Array>()
      files.set(path, bytes)
      this.contents.set(target.runtimeId, files)
      return { bytes: bytes.length }
    },
  }
}

// ── The agent-only check ────────────────────────────────────────────────

export const CLEAN_CALIBRATION: Calibration = {
  hiddenPathsVisible: false,
  baselineConnections: {},
  probeKernel: { id: "kernel-probe", executionCount: 1, startMs: 4200, rttMs: 180 },
  snippetVersion: "fake",
  at: "2026-11-17T09:00:00.000Z",
}

export class FakeAgentOnlyCheck implements AgentOnlyCheck {
  readonly calls: Call[] = []
  verdict: ProbeVerdict = { ok: true, findings: { mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 }, at: "2026-11-17T09:00:00.000Z" }
  async calibrate(target: { runtimeId: string }, nonce: string) {
    this.calls.push({ method: "calibrate", args: [target, nonce] })
    return CLEAN_CALIBRATION
  }
  async probe(target: { runtimeId: string }, input: { nonce: string; calibration: Calibration; fresh: boolean }) {
    this.calls.push({ method: "probe", args: [target, input] })
    return this.verdict
  }
}

// ── Vertex, Drive, GCS ──────────────────────────────────────────────────

export class FakeVertex implements VertexApi {
  readonly calls: Call[] = []
  jobs = new Map<string, EnterpriseJob>()
  schedules = new Map<string, EnterpriseSchedule>()
  runtimes = new Map<string, EnterpriseRuntime>()
  templates: Record<string, unknown>[] = []
  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args })
  }
  async listJobs(account: string, input: unknown) {
    this.record("listJobs", [account, input])
    return [...this.jobs.values()]
  }
  async getJob(account: string, name: string) {
    this.record("getJob", [account, name])
    return this.jobs.get(name)
  }
  /** Create LROs by job name, as `listJobOperations` lists them. */
  operations = new Map<string, { name: string; done: boolean }[]>()
  async createJob(account: string, input: { jobId: string; body: Record<string, unknown> }) {
    this.record("createJob", [account, input])
    const name = `jobs/${input.jobId}`
    const existing = this.jobs.get(name)
    // A create that joins an existing job has no LRO of its own.
    if (existing) return { job: existing }
    const job: EnterpriseJob = { name, displayName: String(input.body.displayName ?? input.jobId), state: "JOB_STATE_PENDING" }
    this.jobs.set(name, job)
    const operation = `${name}/operations/op-1`
    this.operations.set(name, [{ name: operation, done: false }])
    return { job, operation }
  }
  async listJobOperations(account: string, job: string) {
    this.record("listJobOperations", [account, job])
    return this.operations.get(job) ?? []
  }
  async deleteJob(account: string, name: string) {
    this.record("deleteJob", [account, name])
    this.jobs.delete(name)
  }
  async cancelOperation(account: string, operation: string) {
    this.record("cancelOperation", [account, operation])
  }
  /** Understands only Google's exact `display_name="…"` filter, as the reconcile sends it. */
  async listSchedules(account: string, input: { filter?: string } = {}) {
    this.record("listSchedules", [account, input])
    const exact = /^display_name="(.*)"$/.exec(input.filter ?? "")?.[1]
    return [...this.schedules.values()].filter((schedule) => exact === undefined || schedule.displayName === exact)
  }
  async getSchedule(account: string, name: string) {
    this.record("getSchedule", [account, name])
    return this.schedules.get(name)
  }
  async createSchedule(account: string, body: Record<string, unknown>) {
    this.record("createSchedule", [account, body])
    const schedule: EnterpriseSchedule = { name: `schedules/${this.schedules.size + 1}`, displayName: String(body.displayName), cron: String(body.cron), state: "ACTIVE" }
    this.schedules.set(schedule.name, schedule)
    return schedule
  }
  async updateSchedule(account: string, name: string, body: Record<string, unknown>) {
    this.record("updateSchedule", [account, name, body])
    const schedule = { ...this.schedules.get(name)!, ...(body as Partial<EnterpriseSchedule>) }
    this.schedules.set(name, schedule)
    return schedule
  }
  private setState(name: string, state: string) {
    const schedule = this.schedules.get(name)
    if (!schedule) throw new ColabError("NOT_FOUND")
    this.schedules.set(name, { ...schedule, state })
  }
  async pauseSchedule(account: string, name: string) {
    this.record("pauseSchedule", [account, name])
    this.setState(name, "PAUSED")
  }
  async resumeSchedule(account: string, name: string) {
    this.record("resumeSchedule", [account, name])
    this.setState(name, "ACTIVE")
  }
  async deleteSchedule(account: string, name: string) {
    this.record("deleteSchedule", [account, name])
    this.schedules.delete(name)
  }
  async listRuntimes(account: string) {
    this.record("listRuntimes", [account])
    return [...this.runtimes.values()]
  }
  async stopRuntime(account: string, name: string) {
    this.record("stopRuntime", [account, name])
    const runtime = this.runtimes.get(name)
    if (runtime) this.runtimes.set(name, { ...runtime, state: "STOPPED" })
  }
  async deleteRuntime(account: string, name: string) {
    this.record("deleteRuntime", [account, name])
    this.runtimes.delete(name)
  }
  async listTemplates(account: string) {
    this.record("listTemplates", [account])
    return this.templates
  }
}

export class FakeDrive implements DriveApi {
  readonly calls: Call[] = []
  files = new Map<string, { file: DriveFile; bytes: Uint8Array }>()
  /** Kept-forever revisions per file id, as `keptRevisions` counts them. */
  kept = new Map<string, number>()
  private nextId = 1
  async list(account: string, input: unknown) {
    this.calls.push({ method: "list", args: [account, input] })
    return [...this.files.values()].map((entry) => entry.file)
  }
  async get(account: string, fileId: string) {
    this.calls.push({ method: "get", args: [account, fileId] })
    return this.files.get(fileId)?.file
  }
  async download(account: string, fileId: string) {
    this.calls.push({ method: "download", args: [account, fileId] })
    const entry = this.files.get(fileId)
    if (!entry) throw new ColabError("NOT_FOUND")
    return entry.bytes
  }
  async generateId(account: string) {
    this.calls.push({ method: "generateId", args: [account] })
    return `generated-${this.nextId++}`
  }
  async create(account: string, input: { id?: string; name: string; folder?: string; bytes: Uint8Array; mimeType: string }) {
    this.calls.push({ method: "create", args: [account, input.name] })
    if (input.id !== undefined && this.files.has(input.id)) throw new ColabError("UNAVAILABLE", "The id is already taken (Drive answers 409).")
    const file: DriveFile = { id: input.id ?? `file-${this.files.size + 1}`, name: input.name, mimeType: input.mimeType, headRevisionId: "rev-1", ownedByMe: true }
    this.files.set(file.id, { file, bytes: input.bytes })
    return file
  }
  async update(account: string, fileId: string, input: { bytes?: Uint8Array; trashed?: boolean }) {
    this.calls.push({ method: "update", args: [account, fileId, { trashed: input.trashed }] })
    const entry = this.files.get(fileId)
    if (!entry) throw new ColabError("NOT_FOUND")
    const revision = Number((entry.file.headRevisionId ?? "rev-0").split("-")[1]) + 1
    const file = { ...entry.file, headRevisionId: `rev-${revision}` }
    this.files.set(fileId, { file, bytes: input.bytes ?? entry.bytes })
    return file
  }
  async keepRevision(account: string, fileId: string, revisionId: string) {
    this.calls.push({ method: "keepRevision", args: [account, fileId, revisionId] })
    const kept = this.kept.get(fileId) ?? 0
    if (kept >= 200) return false
    this.kept.set(fileId, kept + 1)
    return true
  }
  async keptRevisions(account: string, fileId: string) {
    this.calls.push({ method: "keptRevisions", args: [account, fileId] })
    return { kept: this.kept.get(fileId) ?? 0, truncated: false }
  }
}

export class FakeGcs implements GcsApi {
  readonly calls: Call[] = []
  objects = new Map<string, Uint8Array>()
  async list(account: string, prefix: string) {
    this.calls.push({ method: "list", args: [account, prefix] })
    return [...this.objects.entries()].filter(([uri]) => uri.startsWith(prefix)).map(([uri, bytes]) => ({ uri, size: bytes.length }))
  }
  async read(account: string, uri: string) {
    this.calls.push({ method: "read", args: [account, uri] })
    const bytes = this.objects.get(uri)
    if (!bytes) throw new ColabError("NOT_FOUND")
    return bytes
  }
}

// ── Seams ───────────────────────────────────────────────────────────────

export class FakeRelease implements Release {
  readonly released: { id: string; reason: string; force: boolean }[] = []
  async release(runtime: RuntimeRecord, input: { reason: "plan" | "idle" | "lifetime"; force: boolean }) {
    this.released.push({ id: runtime.id, reason: input.reason, force: input.force })
    return { harvested: [...runtime.keep], released: true, warnings: [] }
  }
}

/** Calls `read` before each provider read, as package E must: jobs.get, then the GCS reads. */
export class FakeEnterpriseRuns implements EnterpriseRuns {
  readonly calls: Call[] = []
  async execution(account: string, input: unknown, _signal: AbortSignal, read: ProviderRead) {
    this.calls.push({ method: "execution", args: [account, input] })
    await read(OPERATIONS.jobsGet)
    return { state: "ok" }
  }
  async cancel(account: string, job: string, _signal: AbortSignal, read: ProviderRead) {
    this.calls.push({ method: "cancel", args: [account, job] })
    await read(OPERATIONS.jobOperationsList)
    return { state: "ok", action: "cancel-requested" }
  }
  async downloadGcs(account: string, input: unknown, _signal: AbortSignal, read: ProviderRead) {
    this.calls.push({ method: "downloadGcs", args: [account, input] })
    await read(OPERATIONS.storageObjectsGet)
    return { state: "ok" }
  }
}

/** A budget a test sets: `verdict` for every check, and the checks it saw. */
export class FakeBudget implements Budget {
  readonly checks: { account: string; action: string; usd?: number; runtimeHours?: number }[] = []
  verdict: "ok" | "warn" | "refuse" = "ok"
  /** The unit the answer's figures are in: USD for Enterprise, runtime-hours for consumer. */
  unit: "usd" | "runtime-hours" = "usd"
  async check(account: string, input: { action: "runtime.create" | "job.create" | "schedule.create" | "schedule.resume"; usd?: number; runtimeHours?: number }, _signal?: AbortSignal) {
    this.checks.push({ account, ...input })
    return { verdict: this.verdict, ...(this.verdict === "ok" ? {} : { spent: 10, limit: 10, unit: this.unit }) }
  }
}

/** A price table a test fills: USD/h per machine, plus per accelerator; one region. */
export class FakePrices implements Prices {
  readonly asOf = "2026-11-17"
  readonly source = "test table"
  readonly region = "us-central1"
  machines = new Map<string, number>([["e2-standard-4", 0.19]])
  accelerators = new Map<string, number>([["T4", 0.4]])
  usdPerHour(input: { machine: string; accelerator?: string; acceleratorCount?: number; diskGb?: number; region?: string }) {
    if (input.region !== undefined && input.region !== this.region) return undefined
    const machine = this.machines.get(input.machine)
    if (machine === undefined) return undefined
    if (input.accelerator === undefined || input.accelerator === "NONE") return machine
    const accelerator = this.accelerators.get(input.accelerator)
    return accelerator === undefined ? undefined : machine + accelerator * (input.acceleratorCount ?? 1)
  }
}

/** Calls `read` before its Drive reads, as package C must. */
export class FakeDriveSync implements DriveSync {
  readonly calls: Call[] = []
  async pull(account: string, input: unknown, _signal: AbortSignal, read: ProviderRead) {
    this.calls.push({ method: "pull", args: [account, input] })
    await read(OPERATIONS.driveFilesGet)
    return { state: "ok" }
  }
}

type StoredCell = { id: string; type: "code" | "markdown" | "raw"; source: string; outputs: readonly Readonly<Record<string, unknown>>[]; executionCount: number | null }

/**
 * Notebooks in memory, by path, with the store's contract: one merge per path at a time, by cell id into the notebook
 * as it is now, and NOTEBOOK_CHANGED (nothing written) when a run cell is gone or its source changed.
 */
export class FakeNotebookStore implements NotebookStore {
  notebooks = new Map<string, StoredCell[]>()
  readonly merges: { path: string; cells: string[]; outputDir: string }[] = []
  private readonly locks = new Map<string, Promise<unknown>>()
  set(path: string, cells: { id: string; type?: StoredCell["type"]; source: string }[]) {
    this.notebooks.set(path, cells.map((cell) => ({ type: "code", outputs: [], executionCount: null, ...cell })))
  }
  private hash(path: string) {
    return `sha256:${createHash("sha256").update(JSON.stringify(this.notebooks.get(path) ?? [])).digest("hex")}`
  }
  async read(path: string) {
    const cells = this.notebooks.get(path)
    if (!cells) throw new ColabError("NOT_FOUND")
    return { hash: this.hash(path), cells: cells.map(({ id, type, source }) => ({ id, type, source })) }
  }
  async mergeRun(path: string, input: { cells: readonly { id: string; source: string; outputs: readonly Readonly<Record<string, unknown>>[]; executionCount: number | null }[]; outputDir: string }) {
    const previous = this.locks.get(path) ?? Promise.resolve()
    const run = previous.then(() => {
      const cells = this.notebooks.get(path)
      if (!cells) throw new ColabError("NOT_FOUND")
      for (const ran of input.cells) {
        const found = cells.find((cell) => cell.id === ran.id)
        if (!found || found.source !== ran.source) throw new ColabError("NOTEBOOK_CHANGED")
      }
      this.notebooks.set(path, cells.map((cell) => {
        const ran = input.cells.find((item) => item.id === cell.id)
        return ran ? { ...cell, outputs: ran.outputs, executionCount: ran.executionCount } : cell
      }))
      this.merges.push({ path, cells: input.cells.map((cell) => cell.id), outputDir: input.outputDir })
      return { hash: this.hash(path) }
    })
    this.locks.set(path, run.catch(() => undefined))
    return run
  }
}

// ── Ledger ──────────────────────────────────────────────────────────────

/** The ledger's contract in memory; the file ledger (src/ledger/store.ts) passes the same unit tests. */
export class MemoryLedger implements Ledger {
  runtimes = new Map<string, RuntimeRecord>()
  runs = new Map<string, RunRecord>()
  events: LedgerEvent[] = []
  private nextSeq = 1
  constructor(private readonly clock: Clock = new FakeClock()) {}
  async putRuntime(record: RuntimeRecord) {
    this.runtimes.set(record.id, record)
  }
  async getRuntime(id: string) {
    return this.runtimes.get(id)
  }
  async listRuntimes(filter: { account?: string; live?: boolean } = {}) {
    return [...this.runtimes.values()].filter((record) => (filter.account === undefined || record.account === filter.account) && (!filter.live || record.state === "creating" || record.state === "ready"))
  }
  async taint(id: string, taint: Taint) {
    const record = this.runtimes.get(id)
    if (!record || record.tainted) return record
    const next = { ...record, tainted: taint }
    this.runtimes.set(id, next)
    await this.append({ type: "runtime.tainted", id, account: record.account })
    return next
  }
  /** As the file ledger: appends `run.finished` when this write makes the run final and it was not before. */
  async putRun(record: RunRecord) {
    const previous = this.runs.get(record.runId)
    this.runs.set(record.runId, record)
    if (isFinal(record) && (previous === undefined || !isFinal(previous))) await this.append({ type: "run.finished", id: record.runId, account: record.account })
  }
  async getRun(runId: string) {
    return this.runs.get(runId)
  }
  async listRuns(filter: { account?: string; since?: string; state?: RunRecord["state"] } = {}) {
    return [...this.runs.values()].filter((run) => (filter.account === undefined || run.account === filter.account) && (filter.state === undefined || run.state === filter.state) && (filter.since === undefined || run.startedAt >= filter.since))
  }
  async append(event: Omit<LedgerEvent, "seq" | "at">) {
    const full = { ...event, seq: this.nextSeq++, at: this.clock.now().toISOString() }
    this.events.push(full)
    return full
  }
  async eventsSince(seq: number, limit: number) {
    const oldest = this.events[0]?.seq ?? this.nextSeq
    return { events: this.events.filter((event) => event.seq > seq).slice(0, limit), expired: seq < oldest - 1, oldest }
  }
  async prune(now: Date) {
    const before = this.events.length
    this.events = this.events.filter((event) => now.getTime() - Date.parse(event.at) < 90 * 86_400_000)
    return before - this.events.length
  }
}

// ── Deps ────────────────────────────────────────────────────────────────

export interface Fakes {
  readonly clock: FakeClock
  readonly auth: FakeAuth
  readonly colab: FakeColabApi
  readonly runtime: FakeRuntimeProtocol
  readonly check: FakeAgentOnlyCheck
  readonly vertex: FakeVertex
  readonly drive: FakeDrive
  readonly gcs: FakeGcs
  readonly ledger: MemoryLedger
  readonly release: FakeRelease
  readonly budget: FakeBudget
  readonly enterprise: FakeEnterpriseRuns
  readonly prices: FakePrices
  readonly notebooks: FakeNotebookStore
  readonly driveSync: FakeDriveSync
}

/** A Deps made of fakes, with the plugin's real plan store and run events, and the options a test passes. */
export function fakeDeps(input: { readonly options?: unknown; readonly directory?: string } = {}): { readonly deps: Deps; readonly fakes: Fakes; readonly options: Options } {
  const options = loadOptions(input.options ?? {})
  const clock = new FakeClock()
  const fakes: Fakes = {
    clock,
    auth: new FakeAuth(),
    colab: new FakeColabApi(),
    runtime: new FakeRuntimeProtocol(),
    check: new FakeAgentOnlyCheck(),
    vertex: new FakeVertex(),
    drive: new FakeDrive(),
    gcs: new FakeGcs(),
    ledger: new MemoryLedger(clock),
    release: new FakeRelease(),
    budget: new FakeBudget(),
    enterprise: new FakeEnterpriseRuns(),
    prices: new FakePrices(),
    notebooks: new FakeNotebookStore(),
    driveSync: new FakeDriveSync(),
  }
  const deps: Deps = {
    options,
    directory: input.directory ?? "/project",
    plans: new PlanStore(options.planTtlSeconds, () => clock.now().getTime()),
    events: createRunEvents(),
    ...fakes,
  }
  return { deps, fakes, options }
}
