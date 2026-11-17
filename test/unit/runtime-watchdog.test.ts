// Package B's watchdog (design §6, §8.2 layer 1; §16 row B). It starts before a run and is cancelled after it, in silent
// requests, so a run is bounded even when OpenCode exits in the middle.
import { describe, expect, it } from "vitest"
import type { KernelSession } from "../../src/ports.js"
import { cancelWatchdog, startWatchdog, watchdogCancelSnippet, watchdogStartSnippet } from "../../src/runtime/watchdog.js"
import { createRuntimeFixture, RUNTIME_ID } from "../fakes/runtime-env.js"

const signal = () => new AbortController().signal
const TARGET = { account: "default", runtimeId: RUNTIME_ID }

describe("the run watchdog", () => {
  it("starts before a run and cancels after it, in silent requests with no stdin", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = await fixture.ports.runtime.openSession(TARGET, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, signal())
      await startWatchdog(session, 1_800, signal())
      await cancelWatchdog(session, signal())
      expect(fixture.jupyter.watchdogs).toEqual([1800])
      expect(fixture.jupyter.watchdogCancels).toBe(1)
      const requests = fixture.jupyter.executed.filter((entry) => entry.code.includes("_oc_watchdog_"))
      expect(requests).toHaveLength(2)
      expect(requests.every((entry) => entry.silent === true && entry.allowStdin === false)).toBe(true)
      await session.close()
    } finally {
      await fixture.close()
    }
  })

  it("is also offered on the session handle package D receives, without an import from this package", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const session = (await fixture.ports.runtime.openSession(TARGET, { name: "oc-nonce-1-run", path: "/content/analysis.ipynb" }, signal())) as KernelSession & {
        watchdog?: (seconds: number | null, signal: AbortSignal) => Promise<void>
      }
      expect(typeof session.watchdog).toBe("function")
      await session.watchdog?.(900, signal())
      await session.watchdog?.(null, signal())
      expect(fixture.jupyter.watchdogs).toEqual([900])
      expect(fixture.jupyter.watchdogCancels).toBe(1)
      await session.close()
    } finally {
      await fixture.close()
    }
  })

  it("carries the run's own number into the kernel and nothing else", () => {
    expect(watchdogStartSnippet(1_800)).toContain("_oc_watchdog_start(1800)")
    expect(watchdogStartSnippet(1_800)).not.toContain("print(")
    expect(watchdogStartSnippet(Number.NaN)).toContain("_oc_watchdog_start(0)")
    expect(watchdogStartSnippet(-5)).toContain("_oc_watchdog_start(0)")
    expect(watchdogStartSnippet(90.9)).toContain("_oc_watchdog_start(90)")
    expect(watchdogCancelSnippet()).toContain("_oc_watchdog_cancel()")
  })
})
