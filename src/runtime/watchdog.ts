/**
 * The kernel-side watchdog (design §6, §8.2 layer 1; package B owns the transport half).
 *
 * Before a run, one silent `execute_request` starts a Python timer thread that calls `_thread.interrupt_main()` at
 * `timeoutSec`; one silent request after the run cancels it. That bounds a run even if OpenCode exits in the middle —
 * Colab's own idle timeouts only apply once code stops — and it is the reason a run needs no live tool call to end.
 *
 * Both requests are `silent: true, store_history: false` and carry `allow_stdin: false`, so they leave no trace in the
 * agent's history and cannot prompt. It bounds runs, not a runtime's lifetime, and cannot interrupt C code that ignores
 * signals; the docs say both.
 */
import { ColabError } from "../domain/errors.js"
import type { KernelSession } from "../ports.js"

/** The name the timer lives under in the kernel's globals, so start and cancel agree. */
const TIMER = "_oc_watchdog_timer"

/** The code that starts (or replaces) the timer. `seconds` is a number spelled by this package, never a cell's text. */
export function watchdogStartSnippet(seconds: number): string {
  const value = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return [
    "import threading as _oc_threading, _thread as _oc_thread",
    "def _oc_watchdog_start(seconds):",
    "    previous = globals().get('" + TIMER + "')",
    "    if previous is not None:",
    "        previous.cancel()",
    "    timer = _oc_threading.Timer(float(seconds), _oc_thread.interrupt_main)",
    "    timer.daemon = True",
    "    globals()['" + TIMER + "'] = timer",
    "    timer.start()",
    `_oc_watchdog_start(${value})`,
    "",
  ].join("\n")
}

/** The code that cancels the timer, if one is running. */
export function watchdogCancelSnippet(): string {
  return [
    "def _oc_watchdog_cancel():",
    "    timer = globals().get('" + TIMER + "')",
    "    if timer is not None:",
    "        timer.cancel()",
    "        globals()['" + TIMER + "'] = None",
    "_oc_watchdog_cancel()",
    "",
  ].join("\n")
}

const QUIET: { readonly allowStdin: false; readonly silent: boolean; readonly storeHistory: boolean } = { allowStdin: false, silent: true, storeHistory: false }

/** Sends one silent request and drains its iopub stream so the kernel is idle when this returns. */
async function run(session: KernelSession, code: string, signal: AbortSignal, what: string): Promise<void> {
  for await (const _message of session.execute(code, QUIET, signal)) {
    // Nothing to keep: these requests are silent and print nothing.
  }
  if (signal.aborted) throw new ColabError("CANCELLED", `The ${what} request was stopped before the kernel answered.`)
}

/** Starts the watchdog on the session's kernel; replaces any timer a previous run left. */
export async function startWatchdog(session: KernelSession, seconds: number, signal: AbortSignal): Promise<void> {
  await run(session, watchdogStartSnippet(seconds), signal, "watchdog start")
}

/** Cancels the watchdog; safe when none is running. */
export async function cancelWatchdog(session: KernelSession, signal: AbortSignal): Promise<void> {
  await run(session, watchdogCancelSnippet(), signal, "watchdog cancel")
}
