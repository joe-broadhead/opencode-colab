// The action table (design §6, §7.1, §7.2, §10): twenty tools, twelve reads, the dotted actions, the permission-only
// reads, the operations, and every §7.1 row mapped to one tool or plan action with its category.
import { describe, expect, it } from "vitest"
import {
  ASSERTABLE_ACTIONS,
  CHANGE_TABLE,
  CLEANUP_ACTION,
  DECLARED_ACTIONS,
  isReadOperation,
  OPERATIONS,
  PERMISSION_ONLY,
  PLAN_ACTIONS,
  REFUSED_PLAN_ACTIONS,
  runResources,
  TOOLS,
  actionOf,
  toolId,
} from "../../src/domain/actions.js"
import { ERROR_CODES } from "../../src/domain/errors.js"

describe("the tools", () => {
  it("are design §6's twenty, twelve reads and eight changes, in its order", () => {
    expect(TOOLS.map((tool) => toolId(tool.name))).toEqual([
      "colab_status", "colab_specs", "colab_runtimes", "colab_find", "colab_notebook", "colab_files", "colab_execution", "colab_jobs", "colab_schedules", "colab_plan", "colab_events_list", "colab_runtimes_read",
      "colab_edit", "colab_run", "colab_cancel", "colab_upload", "colab_download", "colab_pause", "colab_write", "colab_delete",
    ])
    expect(TOOLS.filter((tool) => tool.class === "read")).toHaveLength(12)
    expect(TOOLS.find((tool) => tool.name === "download")?.class).toBe("export")
    expect(TOOLS.find((tool) => tool.name === "delete")?.class).toBe("destructive")
  })

  it("assert dotted actions; colab.read and colab.probe are the two permission-only reads; colab.cleanup is the command's", () => {
    expect(actionOf("run")).toBe("colab.run")
    expect(PERMISSION_ONLY.map((entry) => entry.action)).toEqual(["colab.read", "colab.probe"])
    expect(DECLARED_ACTIONS).toHaveLength(22)
    expect(ASSERTABLE_ACTIONS).toEqual([...DECLARED_ACTIONS, CLEANUP_ACTION])
    expect(DECLARED_ACTIONS).not.toContain(CLEANUP_ACTION)
  })

  it("colab_run asserts once on the execute operation and the runtime", () => {
    expect(runResources("work", "oc-01")).toEqual(["work:jupyter.kernels.execute", "work:runtime:oc-01"])
  })
})

describe("the operations", () => {
  it("are unique, and every read one ends in a read verb", () => {
    const values = Object.values(OPERATIONS)
    expect(new Set(values).size).toBe(values.length)
    const reads = Object.entries(OPERATIONS).filter(([key]) => /List$|Get$/.test(key))
    for (const [key, operation] of reads) expect(isReadOperation(operation), key).toBe(true)
    expect(isReadOperation(OPERATIONS.runtimesCreate)).toBe(false)
  })
})

describe("the plan actions", () => {
  it("are design §7.2's twelve, with their categories", () => {
    expect(Object.fromEntries(Object.entries(PLAN_ACTIONS).map(([action, entry]) => [action, entry.category]))).toEqual({
      "runtime.create": "write",
      "runtime.stop": "write",
      "runtime.delete": "delete",
      "job.create": "write",
      "job.delete": "delete",
      "schedule.create": "write",
      "schedule.update": "write",
      "schedule.resume": "write",
      "schedule.delete": "delete",
      "drive.create": "write",
      "drive.update": "write",
      "drive.trash": "delete",
    })
  })

  it("never create, start or template an Enterprise runtime (D10), and refuse sharing", () => {
    expect(Object.keys(PLAN_ACTIONS["runtime.create"].backends)).toEqual(["colab"])
    expect(Object.keys(PLAN_ACTIONS["runtime.stop"].backends)).toEqual(["enterprise"])
    expect(REFUSED_PLAN_ACTIONS["runtime.start"]).toBe("ACTION_UNSUPPORTED")
    expect(REFUSED_PLAN_ACTIONS.share).toBe("SHARE_UNSUPPORTED")
    for (const code of Object.values(REFUSED_PLAN_ACTIONS)) expect(ERROR_CODES).toContain(code)
  })
})

describe("design §7.1", () => {
  it("maps every row to exactly one tool, plan action or refusal, with a matching category", () => {
    const tools = new Map(TOOLS.map((tool) => [tool.name, tool.class]))
    for (const row of CHANGE_TABLE) {
      if (row.path === "read tools") {
        expect(row.kind).toBe("read")
      } else if (row.path.startsWith("plan:")) {
        const entry = PLAN_ACTIONS[row.path.slice(5) as keyof typeof PLAN_ACTIONS]
        expect(entry, row.what).toBeDefined()
        expect(entry.category, row.what).toBe(row.kind === "destructive" ? "delete" : "write")
      } else if (row.path.startsWith("refused:")) {
        expect(row.kind).toBe("refused")
        expect(ERROR_CODES).toContain(row.path.slice(8))
      } else {
        const cls = tools.get(row.path)
        expect(cls, row.what).toBeDefined()
        expect(cls === "export" ? "export" : cls === "destructive" ? "destructive" : "change", row.what).toBe(row.kind)
      }
    }
    const planned = new Set(CHANGE_TABLE.filter((row) => row.path.startsWith("plan:")).map((row) => row.path.slice(5)))
    expect([...planned].sort()).toEqual(Object.keys(PLAN_ACTIONS).sort())
  })
})
