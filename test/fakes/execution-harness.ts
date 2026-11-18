/**
 * Package D's test double for the runtime protocol, richer than Day 0's: a kernel whose scripted iopub can be gated
 * (so a test can hold a run in flight and cancel, wait or start a second run), and an agent-only check whose verdicts
 * a test queues (clean before a run, a finding after it). It composes Day 0's fakes: `FakeRuntimeProtocol`'s contents
 * and call log are inherited, and nothing here changes another package's fake.
 *
 * The iopub shapes it replays are Jupyter's messaging protocol (design §18 [19]:
 * https://jupyter-client.readthedocs.io/en/stable/messaging.html), and the nbformat outputs D writes are nbformat 4's
 * code-cell outputs (https://nbformat.readthedocs.io/en/latest/format_description.html#code-cell-outputs). No shape here
 * is invented: each fixture names the message it replays.
 */
import { randomUUID } from "node:crypto"
import type { Calibration, IopubMessage, ProbeVerdict, RuntimeRecord, SessionInfo } from "../../src/ports.js"
import { cancelWatchdog, startWatchdog } from "../../src/runtime/watchdog.js"
import { toolHandlers } from "../../src/tools/registry.js"
import { runTool, type Runner } from "../../src/tools/spec.js"
import { FakeAgentOnlyCheck, FakeKernelSession, FakeRuntimeProtocol, fakeDeps, RecordingPermission, type Fakes } from "./index.js"

export { RecordingPermission } from "./index.js"

/** The runtime every test uses: the plugin's own, ready, calibrated. */
export function runtimeRecord(overrides: Partial<RuntimeRecord> = {}): RuntimeRecord {
  return {
    id: "oc-01jexecruntime0000000000",
    account: "default",
    backend: "colab",
    spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" },
    createdAt: "2026-11-17T08:00:00.000Z",
    nonce: "0123456789abcdef0123456789abcdef",
    keep: ["/content/outputs/**"],
    lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
    state: "ready",
    calibration: {
      hiddenPathsVisible: false,
      baselineConnections: {},
      probeKernel: { id: "kernel-probe", executionCount: 1, startMs: 4200, rttMs: 180 },
      snippetVersion: "test",
      at: "2026-11-17T08:00:10.000Z",
    },
    ...overrides,
  }
}

/** A Deps made of fakes with one runtime of the plugin's own already in the ledger. */
export async function prepared(input: { readonly options?: unknown; readonly record?: RuntimeRecord; readonly directory?: string; readonly withRuntime?: boolean } = {}): Promise<{
  readonly deps: ReturnType<typeof fakeDeps>["deps"]
  readonly fakes: Fakes
  readonly record: RuntimeRecord
  readonly runtime: FatRuntimeProtocol
}> {
  const { deps, fakes } = fakeDeps({ options: input.options ?? {}, ...(input.directory ? { directory: input.directory } : {}) })
  const record = input.record ?? runtimeRecord({ account: deps.options.accounts[0]!.alias })
  if (input.withRuntime !== false) await deps.ledger.putRuntime(record)
  const runtime = new FatRuntimeProtocol()
  return { deps: { ...deps, runtime }, fakes, record, runtime }
}

/** The wrapper's runner over a fake Deps, recording every permission ask. */
export function runnerFor(deps: ReturnType<typeof fakeDeps>["deps"]): { readonly runner: Runner; readonly permission: RecordingPermission } {
  const permission = new RecordingPermission()
  const handlers = toolHandlers(() => runner)
  const runner: Runner = { deps, assert: permission.assert, handler: (name) => handlers[name] }
  return { runner, permission }
}

/** One tool call. */
export const call = (id = "call_1", signal = new AbortController().signal) => ({ sessionID: "ses_test", agent: "build", messageID: "msg_test", id, signal })

/** Runs a tool through the same wrapper the host uses, with the permission a test chooses. */
export function toolWith<Name extends keyof ReturnType<typeof toolHandlers>>(
  deps: ReturnType<typeof fakeDeps>["deps"],
  permission: RecordingPermission,
  name: Name,
  input: unknown,
  options: { readonly callId?: string; readonly signal?: AbortSignal } = {},
) {
  const handlers = toolHandlers(() => runner)
  const runner: Runner = { deps, assert: permission.assert, handler: (toolName) => handlers[toolName] }
  return { result: runTool(name, input, call(options.callId, options.signal), runner), permission }
}

/** Runs a tool with a recording permission that allows everything, as the default rules do at access all. */
export function tool<Name extends keyof ReturnType<typeof toolHandlers>>(deps: ReturnType<typeof fakeDeps>["deps"], name: Name, input: unknown, options: { readonly callId?: string; readonly signal?: AbortSignal } = {}) {
  return toolWith(deps, new RecordingPermission(), name, input, options)
}

/** The iopub message a fixture replays, by its Jupyter `msg_type`. */
export const iopub = (msgType: string, content: Record<string, unknown>): Omit<IopubMessage, "parentMsgId"> => ({ msgType, content })

/** Jupyter `status` (messaging.html#status): the kernel's execution state. */
export const alive = (state: "busy" | "starting" = "busy") => iopub("status", { execution_state: state })

/** A promise a test opens when it wants a run to finish, and that an interrupt opens too, as Jupyter's does. */
export interface Gate {
  readonly promise: Promise<void>
  readonly open: () => void
}

export function gate(): Gate {
  let open = () => undefined as void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** A kernel session a test can gate: `execute` yields the scripted messages, then waits at the gate before idle. */
export class ScriptedSession extends FakeKernelSession {
  interrupted = false
  constructor(
    session: SessionInfo,
    private readonly script: (code: string, options: { silent: boolean }) => readonly Omit<IopubMessage, "parentMsgId">[],
    private readonly gate: Gate | undefined,
  ) {
    super(session, () => [])
  }

  override async *execute(code: string, options: { allowStdin: false; silent: boolean; storeHistory: boolean }, signal?: AbortSignal) {
    this.executed.push({ code, allowStdin: options.allowStdin, silent: options.silent })
    const parentMsgId = randomUUID()
    for (const message of this.script(code, { silent: options.silent })) {
      signal?.throwIfAborted()
      yield { parentMsgId, ...message }
    }
    // Only real cell code waits: the watchdog's silent requests must return at once.
    if (this.gate && !options.silent) await this.gate.promise
    signal?.throwIfAborted()
    if (this.interrupted) yield { parentMsgId, msgType: "error", content: { ename: "KeyboardInterrupt", evalue: "", traceback: [] } }
    yield { parentMsgId, msgType: "status", content: { execution_state: "idle" } }
  }

  override async interrupt() {
    this.interrupts += 1
    this.interrupted = true
    this.gate?.open()
  }

  override async restart() {
    this.restarts += 1
    this.interrupted = true
    this.gate?.open()
  }

  override async watchdog(seconds: number | null) {
    // Package B's session sends the bound as silent execute requests; this fake does the same, so a test can see that
    // the start and the cancel are silent and paired (design §8.2).
    this.watchdogs.push(seconds)
    const signal = new AbortController().signal
    if (seconds === null) await cancelWatchdog(this, signal)
    else await startWatchdog(this, seconds, signal)
  }
}

/** Day 0's protocol, with a scripted/gated kernel and its call log kept. */
export class FatRuntimeProtocol extends FakeRuntimeProtocol {
  script: (code: string, options: { silent: boolean }) => readonly Omit<IopubMessage, "parentMsgId">[] = () => [iopub("stream", { name: "stdout", text: "ok\n" })]
  /** A gate `execute` waits at, when set, before it yields idle; an interrupt opens it, as Jupyter's does. */
  gate?: Gate
  /** The sessions this protocol opened. */
  readonly scripted: ScriptedSession[] = []
  /** When set, openSession fails, as a runtime that cannot be reached does. */
  failOpen?: Error

  override async openSession(target: { account: string; runtimeId: string }, input: { name: string; path: string }, signal?: AbortSignal): Promise<ScriptedSession> {
    this.calls.push({ method: "openSession", args: [target, input] })
    if (this.failOpen) throw this.failOpen
    const session: SessionInfo = { id: randomUUID(), name: input.name, path: input.path, kernelId: randomUUID() }
    this.sessions_.set(target.runtimeId, [...(this.sessions_.get(target.runtimeId) ?? []), session])
    const scripted = new ScriptedSession(session, this.script, this.gate)
    this.scripted.push(scripted)
    return scripted
  }

  /** The latest opened session: where a test looks for the run's requests. */
  get last(): ScriptedSession | undefined {
    return this.scripted.at(-1)
  }
}

/** The agent-only check with a queue of verdicts: the first clean, the second a finding, and so on. */
export class QueueCheck extends FakeAgentOnlyCheck {
  readonly queue: ProbeVerdict[] = []
  override async probe(target: { runtimeId: string; account: string }, input: { nonce: string; calibration: Calibration; fresh: boolean }) {
    const next = this.queue.length > 1 ? this.queue.shift()! : this.queue[0]
    if (next) {
      this.calls.push({ method: "probe", args: [target, input] })
      return next
    }
    return super.probe(target, input)
  }
}

export const CLEAN: ProbeVerdict = { ok: true, findings: { mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 }, at: "2026-11-17T09:00:00.000Z" }
export const DIRTY: ProbeVerdict = { ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { mounts: true, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 }, at: "2026-11-17T09:00:00.000Z" }
export const SHARED: ProbeVerdict = { ok: false, code: "RUNTIME_SHARED", findings: { mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 1, extraConnections: 0 }, at: "2026-11-17T09:00:00.000Z" }
export const UNVERIFIED: ProbeVerdict = { ok: false, code: "RUNTIME_UNVERIFIED", at: "2026-11-17T09:00:00.000Z" }
