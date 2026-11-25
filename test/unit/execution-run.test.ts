// Package D's run tests (design §15.1 agent-only runtimes, §9.1, §9.3, §9.4): the run only on a calibrated,
// untainted runtime of the plugin's own; the pre- and post-run probes; the code preview in the ask; the watchdog; the
// one-ask rule; write-back through package C's store; cancel, wait and timeout; and KERNEL_BUSY. No test calls Google.
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { metadataFor, providerRun } from "../support/methods.js"
import { ColabError } from "../../src/domain/errors.js"
import { liveRun, resetLiveRuns } from "../../src/provider/execution/runs.js"
import { alive, CLEAN, DIRTY, gate, iopub, prepared, QueueCheck, runtimeRecord, tool } from "../fakes/execution-harness.js"

const made: string[] = []
async function workspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "colab-run-"))
  made.push(dir)
  return dir
}
afterEach(async () => {
  resetLiveRuns()
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true })
})

const ok = () => [alive(), iopub("stream", { name: "stdout", text: "ok\n" }), iopub("status", { execution_state: "idle" })]

async function settled(runId: string) {
  const live = liveRun(runId)
  if (live) await live.done
}

describe("colab_run", () => {
  it("runs only on a runtime of the plugin's own, refusing before any network call", async () => {
    const { deps, fakes, runtime } = await prepared({ directory: await workspace() })
    for (const [record, code] of [
      [undefined, "INPUT_INVALID"],
      [runtimeRecord({ state: "creating" }), "INPUT_INVALID"],
      [runtimeRecord({ state: "released" }), "UNAVAILABLE"],
      [runtimeRecord({ tainted: { code: "RUNTIME_SHARED", at: "2026-11-17T09:00:00.000Z" } }), "INPUT_INVALID"],
      [runtimeRecord({ calibration: undefined }), "INPUT_INVALID"],
      [runtimeRecord({ account: "other" }), "INPUT_INVALID"],
    ] as const) {
      if (record) await deps.ledger.putRuntime(record)
      const { result } = tool(deps, "run", { runtime: record?.id ?? "oc-unknown", code: "print(1)", wait: 0 })
      expect(await result, code).toMatchObject({ error: code })
    }
    expect(runtime.calls).toHaveLength(0)
    expect(fakes.colab.calls).toHaveLength(0)
    expect(await fakes.ledger.listRuns({ account: "default" })).toHaveLength(0)
  })

  it("refuses an Enterprise account with the job plan as the next step", async () => {
    const { deps } = await prepared({ directory: await workspace(), options: { accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1", outputBucket: "gs://b" } } } })
    const { result } = tool(deps, "run", { account: "work", runtime: "oc-x", code: "print(1)" })
    expect(await result).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect((await result as { next: string }).next).toContain("job.create")
  })

  it("refuses on a finding before the run and taints the runtime for good", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.check.verdict = DIRTY
    const { result } = tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 0 })
    expect(await result).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    expect(runtime.calls).toHaveLength(0)
    expect((await deps.ledger.getRuntime(record.id))?.tainted?.code).toBe("RUNTIME_HAS_CREDENTIALS")
  })

  it("probes again after the run and taints on a late finding, while the run reports its outputs", async () => {
    const directory = await workspace()
    const { deps, fakes, record, runtime } = await prepared({ directory })
    const check = new QueueCheck()
    check.queue.push(CLEAN, DIRTY)
    Object.assign(deps, { check })
    runtime.script = ok
    const { result } = tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 10 })
    const answer = (await result) as { state: string; cells: unknown[]; message?: string }
    expect(answer.state).toBe("ok")
    expect(answer.cells).toHaveLength(1)
    expect(answer.message).toContain("tainted")
    expect(check.calls.filter((entry) => entry.method === "probe")).toHaveLength(2)
    expect((await deps.ledger.getRuntime(record.id))?.tainted?.code).toBe("RUNTIME_HAS_CREDENTIALS")
    expect(fakes.colab.calls).toHaveLength(0)
  })

  it("asserts colab.run once, with the code preview, the sources' sha256 and the flagged lines", async () => {
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    runtime.script = ok
    const code = ["import requests", "%pip install -q pandas", "!curl https://example.com", "WANDB_API_KEY=0123456789abcdef0123456789abcdef01234567", "1", "2", "3", "4"].join("\n")
    const call = { sessionID: "s", agent: "build", messageID: "m", id: "call_meta", signal: new AbortController().signal }
    const input = { runtime: record.id, code, wait: 10 }
    const metadata = (await metadataFor("run", input, { deps }, call.id)) as { cells: { id: string; lines: string[]; sha256: string; flags?: { line: number; flag: string }[] }[]; timeoutSec: number }
    await providerRun("run", input, call, { deps })
    expect(metadata.timeoutSec).toBe(1800)
    expect(metadata.cells[0]!.id).toBe("code")
    expect(metadata.cells[0]!.lines).toHaveLength(6)
    expect(metadata.cells[0]!.sha256).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(metadata.cells[0]!.lines.join("\n")).not.toContain("0123456789abcdef")
    expect(metadata.cells[0]!.flags?.map((flag) => flag.flag)).toEqual(expect.arrayContaining(["install", "shell", "network"]))
    // Every execute_request is allow_stdin false (design §7.4 step 5).
    expect(runtime.last!.executed.every((request) => request.allowStdin === false)).toBe(true)
  })

  it("writes outputs back through the notebook store, says what landed, and asserts the host's edit", async () => {
    const directory = await workspace()
    const { deps, fakes, record, runtime } = await prepared({ directory })
    const cells = [
      { id: "a", source: "print(1)" },
      { id: "b", source: "print(2)" },
    ]
    fakes.notebooks.set("analysis.ipynb", cells.map((cell) => ({ ...cell, type: "code" as const })))
    runtime.script = ok
    const { result } = tool(deps, "run", { runtime: record.id, notebook: { path: "analysis.ipynb" }, cells: "all", wait: 10 })
    const answer = (await result) as { state: string; cells: { id: string }[]; message?: string; files: string[] }
    expect(answer.state).toBe("ok")
    expect(answer.cells.map((cell) => cell.id)).toEqual(["a", "b"])
    expect(answer.message).toContain("Wrote the outputs of 2 cell(s) into analysis.ipynb (sha256:")
    expect(answer.files.some((file) => file.endsWith("outputs.jsonl"))).toBe(true)
    expect(fakes.notebooks.merges).toHaveLength(1)
    expect(fakes.notebooks.merges[0]!.cells).toEqual(["a", "b"])
    expect(fakes.notebooks.merges[0]!.outputDir).toMatch(/^\.colab\/runs\//)
    expect((await deps.ledger.getRun(answerCellsRunId(answer)))).toBeDefined()
  })

  it("answers NOTEBOOK_CHANGED, writes nothing to the notebook, and names the run's files", async () => {
    const directory = await workspace()
    const { deps, fakes, record, runtime } = await prepared({ directory })
    fakes.notebooks.set("analysis.ipynb", [{ id: "a", type: "code", source: "print(1)" }])
    const refusing = Object.assign(Object.create(fakes.notebooks) as typeof fakes.notebooks, {
      read: fakes.notebooks.read.bind(fakes.notebooks),
      mergeRun: async () => {
        throw new ColabError("NOTEBOOK_CHANGED", "The notebook changed while the run was going.", { next: "The outputs are kept in .colab/runs/x; read the notebook again." })
      },
    })
    Object.assign(deps, { notebooks: refusing })
    runtime.script = ok
    const { result } = tool(deps, "run", { runtime: record.id, notebook: { path: "analysis.ipynb" }, cells: "all", wait: 10 })
    const answer = (await result) as { state: string; message?: string; writeBack?: { state: string; error?: string; runFolder: string } }
    expect(answer.state).toBe("ok")
    expect(answer.writeBack).toMatchObject({ state: "refused", error: "NOTEBOOK_CHANGED" })
    expect(answer.writeBack!.runFolder).toContain(".colab/runs/")
    expect(answer.message).toContain("were not written into it")
    expect(fakes.notebooks.merges).toHaveLength(0)
  })

  it("skips write-back when writeBack is false, and never asks the host's edit", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set("analysis.ipynb", [{ id: "a", type: "code", source: "print(1)" }])
    runtime.script = ok
    const { result } = tool(deps, "run", { runtime: record.id, notebook: { path: "analysis.ipynb" }, cells: "all", wait: 10, writeBack: false })
    expect((await result) as { state: string }).toMatchObject({ state: "ok" })
    expect(fakes.notebooks.merges).toHaveLength(0)
  })

  it("times out at timeoutSec, interrupts the kernel and keeps the watchdog pair", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    runtime.gate = gate()
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
    const { result } = tool(deps, "run", { runtime: record.id, code: "while True: pass", timeoutSec: 1, wait: 10 })
    const failure = (await result) as { state: string; error: string; next: string }
    expect(failure).toMatchObject({ state: "failed", error: "UNAVAILABLE" })
    expect(failure.next).toContain("timeoutSec")
    const session = runtime.last!
    expect(session.watchdogs).toEqual([1, null])
    expect(session.interrupts).toBe(1)
    expect(session.executed.filter((request) => request.silent)).toHaveLength(2)
    const runs = await fakes.ledger.listRuns({ account: "default" })
    expect(runs[0]).toMatchObject({ state: "timeout", errorCode: "RUN_TIMEOUT" })
  })

  it("keeps a run bounded after its tool call has returned: the watchdog interrupts it with no caller waiting", async () => {
    // L7c's offline half: the run outlives the call (wait 0), no caller holds it, and it still ends at timeoutSec because
    // the kernel-side watchdog and the plugin's own timer bound it. The live check asks whether Colab reclaims a runtime
    // whose code is running with only an API WebSocket attached; no test may use a real runtime.
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    runtime.gate = gate()
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
    const running = (await tool(deps, "run", { runtime: record.id, code: "while True: pass", timeoutSec: 1, wait: 0 }).result) as { state: string; runId: string }
    expect(running.state).toBe("running")
    const live = liveRun(running.runId)!
    await live.done
    expect(live.state()).toBe("timeout")
    expect(runtime.last!.watchdogs).toEqual([1, null])
    expect(runtime.last!.interrupts).toBe(1)
    const recordAfter = await fakes.ledger.getRun(running.runId)
    expect(recordAfter).toMatchObject({ state: "timeout", errorCode: "RUN_TIMEOUT" })
  })

  it("cancels a running run through its kernel, and restarts one with state lost", async () => {
    for (const [restart, expected] of [
      [false, "interrupted"],
      [true, "restarted"],
    ] as const) {
      const { deps, record, runtime } = await prepared({ directory: await workspace() })
      runtime.gate = gate()
      runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
      const { result } = tool(deps, "run", { runtime: record.id, code: "while True: pass", wait: 0 })
      const running = (await result) as { state: string; runId: string }
      expect(running.state).toBe("running")
      const cancelled = await tool(deps, "cancel", { runId: running.runId, ...(restart ? { restart: true } : {}) }).result
      expect(cancelled).toMatchObject({ state: "ok", action: expected })
      expect(runtime.last!.interrupts + runtime.last!.restarts).toBeGreaterThan(0)
      await settled(running.runId)
      const execution = await tool(deps, "execution", { runId: running.runId, wait: 1 }).result
      expect(execution).toMatchObject({ state: "cancelled" })
    }
  })

  it("waits for a run in colab_execution, pages a long cell in full, and reports a detached run", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    runtime.gate = gate()
    const long = Array.from({ length: 4000 }, (_, index) => `row ${index}: value`).join("\n")
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: long })]
    const { result } = tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 0 })
    const running = (await result) as { state: string; runId: string }
    expect(running.state).toBe("running")
    setTimeout(() => runtime.gate?.open(), 25)
    const waited = (await tool(deps, "execution", { runId: running.runId, wait: 5 }).result) as { state: string; cells: { stdout: string }[] }
    expect(waited.state).toBe("ok")
    expect(waited.cells[0]!.stdout.length).toBeLessThan(9000)
    const full = (await tool(deps, "execution", { runId: running.runId, cell: "code", full: true, page: 0, wait: 0 }).result) as { cells: { stdout: string }[]; truncated?: boolean }
    expect(full.cells[0]!.stdout.length).toBe(20_000)
    expect(full.truncated).toBe(true)
    const page4 = (await tool(deps, "execution", { runId: running.runId, cell: "code", full: true, page: 3, wait: 0 }).result) as { cells: { stdout: string }[]; truncated?: boolean }
    expect(page4.cells[0]!.stdout).toContain("row 3999")

    const detachedRun = "01jdetachedrun000000000001"
    await fakes.ledger.putRun({ runId: detachedRun, account: "default", backend: "colab", runtime: record.id, cellIds: ["code"], startedAt: "2026-11-17T09:00:00.000Z", state: "running", outputPaths: [] })
    const detached = (await tool(deps, "execution", { runId: detachedRun, wait: 0 }).result) as { state: string; next: string }
    expect(detached.state).toBe("detached")
    expect(detached.next).toContain("/content/outputs")
  })

  it("refuses a second run on the same kernel session with KERNEL_BUSY", async () => {
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    runtime.gate = gate()
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
    const first = (await tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 0 }).result) as { runId: string; state: string }
    expect(first.state).toBe("running")
    const second = await tool(deps, "run", { runtime: record.id, code: "print(2)", wait: 0 }).result
    expect(second).toMatchObject({ state: "refused", error: "INPUT_INVALID" })
    runtime.gate.open()
    await settled(first.runId)
  })

  it("interrupts the run when the tool call's own Stop arrives, answering CANCELLED", async () => {
    const { deps, record, runtime } = await prepared({ directory: await workspace() })
    runtime.gate = gate()
    runtime.script = () => [alive(), iopub("stream", { name: "stdout", text: "working\n" })]
    const controller = new AbortController()
    const pending = tool(deps, "run", { runtime: record.id, code: "print(1)", wait: 10 }, { callId: "call_stop", signal: controller.signal }).result
    setTimeout(() => controller.abort(), 20)
    const answer = (await pending) as { state: string; error: string }
    expect(answer).toMatchObject({ state: "failed", error: "UNAVAILABLE" })
    expect(runtime.last!.interrupts).toBe(1)
  })

  it("reuses one session name per notebook, so variables survive between runs", async () => {
    const { deps, fakes, record, runtime } = await prepared({ directory: await workspace() })
    fakes.notebooks.set("analysis.ipynb", [{ id: "a", type: "code", source: "x = 1" }])
    runtime.script = ok
    for (let index = 0; index < 2; index += 1) await tool(deps, "run", { runtime: record.id, notebook: { path: "analysis.ipynb" }, cells: "all", wait: 10 }).result
    const names = runtime.calls.filter((entry) => entry.method === "openSession").map((entry) => (entry.args[1] as { name: string }).name)
    expect(new Set(names).size).toBe(1)
    expect(names[0]).toMatch(/^oc-0123456789abcdef0123456789abcdef-nb-[0-9a-f]{12}$/)
  })
})

/** Rebuilds the run's id from the message, for the ledger check. */
function answerCellsRunId(answer: { message?: string; files: string[] }): string {
  const match = /\.colab\/runs\/([0-9a-z]+)\//.exec(answer.files[0] ?? "")
  return match?.[1] ?? ""
}
