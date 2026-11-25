/**
 * The in-process run registry (design §9.1, §9.4): a run outlives its tool call, so collection continues in the plugin
 * process after `colab_run` answers `state: "running"`, and `colab_execution` waits on the same handle.
 *
 * It is deliberately process-local. The disk copy (`.colab/runs/<runId>/outputs.jsonl` and the ledger's RunRecord) is
 * what a second process or a restarted plugin reads, and the design's answer there is `state: "detached"`: output is not
 * replayed to a new connection. The registry also holds the kernel-session handle, so `colab_cancel` can interrupt the
 * kernel of a run this process is collecting.
 */
import type { KernelSession, RunRecord } from "../ports.js"
import type { CapturedCell } from "./capture.js"

export interface LiveRun {
  readonly runId: string
  readonly account: string
  readonly runtime: string
  readonly session: string
  readonly kernel: KernelSession
  readonly controller: AbortController
  readonly done: Promise<void>
  readonly state: () => RunRecord["state"]
  readonly cells: () => readonly CapturedCell[]
  readonly error: () => unknown
  readonly interrupt: (kind: "interrupt" | "restart") => Promise<void>
}

interface Entry {
  readonly runId: string
  readonly account: string
  readonly runtime: string
  readonly session: string
  readonly kernel: KernelSession
  readonly controller: AbortController
  cells: CapturedCell[]
  state: RunRecord["state"]
  error: unknown
  readonly done: Promise<void>
  readonly settle: () => void
}

const entries = new Map<string, Entry>()

/** Test hook: forget every live run, so one test's run cannot answer another's. */
export function resetLiveRuns(): void {
  entries.clear()
}

const liveOf = (entry: Entry): LiveRun => ({
  runId: entry.runId,
  account: entry.account,
  runtime: entry.runtime,
  session: entry.session,
  kernel: entry.kernel,
  controller: entry.controller,
  done: entry.done,
  state: () => entry.state,
  cells: () => entry.cells,
  error: () => entry.error,
  async interrupt(kind) {
    // Abort first, so the collector sees the Stop at its next message and records CANCELLED; then tell the kernel to stop
    // the code, which is what actually stops it (design §9.4).
    entry.controller.abort()
    const signal = AbortSignal.timeout(15_000)
    if (kind === "restart") await entry.kernel.restart(signal)
    else await entry.kernel.interrupt(signal)
  },
})

/** Starts a run's handle; the caller collects cells and calls `complete` once, in a `finally`. */
export function beginRun(input: { readonly runId: string; readonly account: string; readonly runtime: string; readonly session: string; readonly kernel: KernelSession }): {
  readonly live: LiveRun
  readonly progress: (cells: readonly CapturedCell[]) => void
  readonly complete: (state: RunRecord["state"], error?: unknown) => void
} {
  const controller = new AbortController()
  let settle = () => undefined as void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const entry: Entry = { ...input, controller, cells: [], state: "running", error: undefined, done, settle }
  entries.set(entry.runId, entry)
  return {
    live: liveOf(entry),
    progress: (cells) => {
      entry.cells = [...cells]
    },
    complete: (state, error) => {
      if (entry.state !== "running") return
      entry.state = state
      entry.error = error
      entry.settle()
    },
  }
}

export const liveRun = (runId: string): LiveRun | undefined => {
  const entry = entries.get(runId)
  return entry ? liveOf(entry) : undefined
}

/** The run collecting on a kernel session now, if any: one run per session (design §9.4, KERNEL_BUSY). */
export const runOnSession = (runtime: string, session: string): LiveRun | undefined => {
  for (const entry of entries.values()) if (entry.state === "running" && entry.runtime === runtime && entry.session === session) return liveOf(entry)
  return undefined
}

/** How many runs this process collects on a runtime: four at a time (design §9.4). */
export const runsOn = (runtime: string): number => [...entries.values()].filter((entry) => entry.state === "running" && entry.runtime === runtime).length
