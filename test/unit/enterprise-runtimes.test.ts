/**
 * Enterprise runtimes (design §6, §7.2, Q3): they are listed and stopped or deleted only by an explicit plan that says
 * what is lost. No creation, no start, no templates, no automation. The idle-shutdown setting is shown, and a runtime
 * whose template has idle shutdown off carries IDLE_SHUTDOWN_OFF. This is the plugin's side of L12; the live check
 * remains unrun.
 */
import { describe, expect, it } from "vitest"
import type { Deps } from "../../src/provider/index.js"
import { STOP_WARNING } from "../../src/provider/enterprise/plans.js"
import { runTool, type Runner } from "../support/methods.js"
import { fakeDeps, RecordingPermission } from "../fakes/index.js"
import { ScriptedGcs } from "../fakes/enterprise-gcs.js"
import { ScriptedVertex } from "../fakes/enterprise-vertex.js"

const call = () => ({ sessionID: "ses_runtimes", agent: "build", messageID: "msg", id: "call", signal: new AbortController().signal })
const OPTIONS = { accounts: { work: { backend: "enterprise" as const, access: "write" as const, project: "proj", region: "us-central1", outputBucket: "gs://results", serviceAccount: "runner@proj.iam.gserviceaccount.com" } } }

function setup() {
  const { deps: base, fakes } = fakeDeps({ options: OPTIONS })
  const vertex = new ScriptedVertex(fakes.clock)
  const gcs = new ScriptedGcs()
  const deps: Deps = { ...base, vertex, gcs }
  const permission = new RecordingPermission()
  let runner: Runner
  runner = { deps }
  return { deps, fakes, vertex, gcs, permission, runner }
}

const RUNTIME = {
  name: "projects/proj/locations/us-central1/notebookRuntimes/rt-1",
  state: "RUNNING",
  machineType: "e2-standard-4",
  idleShutdownMinutes: 180,
  euc: true,
}

describe("runtime.stop", () => {
  it("previews what is lost and what is kept, then stops the runtime", async () => {
    const { runner, vertex } = setup()
    vertex.putRuntime(RUNTIME)
    const planned = (await runTool("plan", { action: "runtime.stop", account: "work", params: { runtime: "rt-1" } }, call(), runner)) as { plan: unknown; preview: Record<string, any>; category: string }
    expect(planned.category).toBe("write")
    expect(planned.preview).toMatchObject({
      action: "runtime.stop",
      runtime: { id: "rt-1", state: "RUNNING", machine: "e2-standard-4", usdPerHour: 0.22, idleShutdownMinutes: 180, euc: true },
      warning: STOP_WARNING,
      loses: expect.stringContaining("kernel state"),
      keeps: expect.stringContaining("still billed"),
    })
    // The exact warning the design requires, word for word.
    expect(planned.preview.warning).toBe("kernel state and running cells are lost; the disk is kept and still billed; the person may be using this runtime — there is no idle signal")
    expect(await runTool("write", { plan: planned.plan }, call(), runner)).toMatchObject({ state: "ok", result: { runtime: "rt-1", state: "STOPPING" } })
    expect(vertex.runtimes.get(RUNTIME.name)!.state).toBe("STOPPED")
  })

  it("flags a template with idle shutdown off, prices a template-only runtime, and refuses a missing one", async () => {
    const { runner, vertex } = setup()
    vertex.templates = [{ name: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", machineSpec: { machineType: "e2-standard-4" } }]
    vertex.putRuntime({ name: "projects/proj/locations/us-central1/notebookRuntimes/rt-2", state: "RUNNING", template: "projects/proj/locations/us-central1/notebookRuntimeTemplates/tpl-1", idleShutdownMinutes: null })
    const planned = (await runTool("plan", { action: "runtime.stop", account: "work", params: { runtime: "rt-2" } }, call(), runner)) as { preview: Record<string, any>; warnings?: string[] }
    expect(planned.preview.runtime).toMatchObject({ usdPerHour: 0.22, idleShutdownMinutes: null, template: "tpl-1" })
    expect(planned.warnings).toEqual(["IDLE_SHUTDOWN_OFF"])
    expect(await runTool("plan", { action: "runtime.stop", account: "work", params: { runtime: "missing" } }, call(), runner)).toMatchObject({ error: "INPUT_INVALID" })
  })

  it("answers PLAN_CHANGED when the runtime moved between the preview and the commit", async () => {
    const { runner, vertex } = setup()
    vertex.putRuntime(RUNTIME)
    const planned = (await runTool("plan", { action: "runtime.stop", account: "work", params: { runtime: "rt-1" } }, call(), runner)) as { plan: unknown }
    vertex.runtimes.set(RUNTIME.name, { ...RUNTIME, state: "STOPPED" })
    expect(await runTool("write", { plan: planned.plan }, call(), runner)).toMatchObject({ error: "PLAN_INVALID" })
  })
})

describe("runtime.delete (Enterprise)", () => {
  it("says the disk is deleted as well as the kernel, then deletes the runtime", async () => {
    const { runner, vertex } = setup()
    vertex.putRuntime(RUNTIME)
    const planned = (await runTool("plan", { action: "runtime.delete", account: "work", params: { runtime: "rt-1" } }, call(), runner)) as { plan: unknown; preview: Record<string, any>; category: string }
    expect(planned.category).toBe("delete")
    expect(planned.preview).toMatchObject({ action: "runtime.delete", warning: STOP_WARNING, deletes: "the disk is deleted", loses: expect.stringContaining("the disk") })
    expect(await runTool("delete", { plan: planned.plan }, call(), runner)).toMatchObject({ state: "ok", result: { runtime: "rt-1", deleted: true } })
    expect(vertex.runtimes.size).toBe(0)
  })
})
