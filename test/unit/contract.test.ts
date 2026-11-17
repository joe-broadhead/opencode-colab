// The tools' schemas and result shapes (design §6, §9): what each input takes and refuses, every result's envelope,
// and that every schema converts to JSON Schema for the host and the tools RPC.
import { describe, expect, it } from "vitest"
import * as z from "zod"
import { PLAN_ACTION_NAMES } from "../../src/domain/actions.js"
import { CONTRACTS, Failure, PLAN_PARAMS } from "../../src/domain/contract.js"
import type { KernelSession, RuntimeProtocol } from "../../src/ports.js"
import { FakeRuntimeProtocol } from "../fakes/index.js"

const ok = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success
const HASH = `sha256:${"a".repeat(64)}`

describe("inputs", () => {
  it("colab_run takes code or a notebook, never both, and cells only with a notebook", () => {
    const { input } = CONTRACTS.run
    expect(ok(input, { runtime: "oc-01", code: "print(1)" })).toBe(true)
    expect(ok(input, { runtime: "oc-01", notebook: { path: "a.ipynb" }, cells: "all" })).toBe(true)
    expect(ok(input, { runtime: "oc-01", notebook: { path: "a.ipynb" }, cells: { from: 0, to: 3 } })).toBe(true)
    expect(ok(input, { runtime: "oc-01" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", notebook: { path: "a.ipynb" } })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", cells: "all" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", code: "x", allowStdin: true })).toBe(false)
  })

  it("colab_edit needs ifHash unless it creates, and create only first", () => {
    const { input } = CONTRACTS.edit
    expect(ok(input, { path: "a.ipynb", ops: [{ op: "create" }] })).toBe(true)
    expect(ok(input, { path: "a.ipynb", ifHash: HASH, ops: [{ op: "replace", cell: "c1", source: "x = 1" }] })).toBe(true)
    expect(ok(input, { path: "a.ipynb", ops: [{ op: "delete", cell: 0 }] })).toBe(false)
    expect(ok(input, { path: "a.ipynb", ifHash: HASH, ops: [{ op: "delete", cell: 0 }, { op: "create" }] })).toBe(false)
  })

  it("colab_download takes exactly one source", () => {
    const { input } = CONTRACTS.download
    expect(ok(input, { runtime: "oc-01", path: "/content/outputs/x.csv" })).toBe(true)
    expect(ok(input, { drive: "file-1" })).toBe(true)
    expect(ok(input, { gcs: "gs://bucket/out.ipynb" })).toBe(true)
    expect(ok(input, { drive: "file-1", gcs: "gs://bucket/x" })).toBe(false)
    expect(ok(input, { runtime: "oc-01" })).toBe(false)
    expect(ok(input, { runtime: "oc-01", path: "relative.csv" })).toBe(false)
  })

  it("colab_write and colab_delete take only the plan id", () => {
    expect(ok(CONTRACTS.write.input, { planId: "plan_abcdefghijklmnopqrstuvwx" })).toBe(true)
    expect(ok(CONTRACTS.delete.input, { planId: "plan_abcdefghijklmnopqrstuvwx", force: true })).toBe(false)
  })

  it("every plan action has params, and schedules and jobs take their bounds", () => {
    expect(Object.keys(PLAN_PARAMS).sort()).toEqual([...PLAN_ACTION_NAMES].sort())
    expect(ok(PLAN_PARAMS["schedule.create"], { notebook: { gcs: "gs://b/n.ipynb" }, displayName: "nightly", cron: "0 9 * * *", maxRunCount: 30 })).toBe(true)
    expect(ok(PLAN_PARAMS["job.create"], { notebook: { path: "a.ipynb" }, timeoutMinutes: 2000 })).toBe(false)
    expect(ok(PLAN_PARAMS["runtime.create"], { spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" }, keep: ["/content/outputs/**"] })).toBe(true)
  })

  it("an account alias is a short lowercase name", () => {
    expect(ok(CONTRACTS.status.input, { account: "work" })).toBe(true)
    expect(ok(CONTRACTS.status.input, { account: "Work Account" })).toBe(false)
  })
})

describe("results", () => {
  it("every tool's result accepts the failure envelope", () => {
    const failure = { state: "refused", error: "NOT_IMPLEMENTED", message: "x.", next: "y." }
    for (const [name, contract] of Object.entries(CONTRACTS)) {
      if (name === "events_list" || name === "runtimes_read") continue
      expect(ok(contract.output, failure), name).toBe(true)
    }
    expect(ok(Failure, { ...failure, error: "MADE_UP" })).toBe(false)
  })

  it("a run's result carries per-cell results and file paths, with running and detached states", () => {
    const cell = { id: "c1", state: "ok", executionCount: 1, ms: 12, stdout: "", stderr: "", rich: [{ mime: "image/png", path: ".colab/runs/r1/c1-0.png", bytes: 2048 }] }
    expect(ok(CONTRACTS.run.output, { state: "running", runId: "r1", cells: [cell], files: [], next: "colab_execution({ runId: \"r1\", wait: 60 })" })).toBe(true)
    expect(ok(CONTRACTS.execution.output, { state: "detached", runId: "r1", cells: [], files: [], warnings: ["DETACHED"] })).toBe(true)
    expect(ok(CONTRACTS.run.output, { state: "ok", runId: "r1", cells: [cell], files: [], warnings: ["NOT_A_WARNING"] })).toBe(false)
  })

  it("every schema converts to JSON Schema", () => {
    for (const [name, contract] of Object.entries(CONTRACTS)) {
      expect(() => z.toJSONSchema(contract.input, { io: "input", unrepresentable: "any" }), name).not.toThrow()
      expect(() => z.toJSONSchema(contract.output, { io: "output", unrepresentable: "any" }), name).not.toThrow()
    }
  })
})

describe("the runtime protocol port, as its fake implements it", () => {
  const target = { account: "default", runtimeId: "oc-01" }
  const signal = new AbortController().signal

  it("a kernel session starts and cancels the watchdog with the plugin's own number", async () => {
    const protocol = new FakeRuntimeProtocol()
    const session: KernelSession = await protocol.openSession(target, { name: "oc-n0nce-main", path: "a.ipynb" }, signal)
    await session.watchdog(1800, signal)
    await session.watchdog(null, signal)
    expect(protocol.opened[0]!.watchdogs).toEqual([1800, null])
  })

  it("files.read reads the whole file without a range, and a byte range with one, end inclusive", async () => {
    const protocol = new FakeRuntimeProtocol()
    protocol.contents.set("oc-01", new Map([["/content/outputs/x.csv", new TextEncoder().encode("0123456789")]]))
    const text = async (stream: AsyncIterable<Uint8Array>) => {
      let out = ""
      for await (const chunk of stream) out += new TextDecoder().decode(chunk)
      return out
    }
    const read: RuntimeProtocol["files"]["read"] = protocol.files.read
    expect(await text(await read(target, "/content/outputs/x.csv", signal))).toBe("0123456789")
    expect(await text(await read(target, "/content/outputs/x.csv", signal, { range: { start: 2, end: 4 } }))).toBe("234")
    expect(await text(await read(target, "/content/outputs/x.csv", signal, { range: { start: 7 } }))).toBe("789")
    expect(protocol.files.reads.map((entry) => entry.range)).toEqual([undefined, { start: 2, end: 4 }, { start: 7 }])
  })
})
