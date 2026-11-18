// The server part's wiring, on a fake host context: what package F's cost registration reports reaches status as
// problems (colab-10 contract request 3), and nothing else in setup depends on F's hooks.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { costProblem, createColabPlugin } from "../../src/plugin.js"
import { ColabRpc, type Status } from "../../src/rpc.js"
import { fakeDeps } from "../fakes/index.js"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const disposable = { dispose: async () => undefined, data: [] as unknown[] }

/** Any call the host context does not name answers a disposable registration with empty data. */
function anything(): unknown {
  return new Proxy(async () => disposable, { get: (_target, key) => (key === "then" ? undefined : anything()) })
}

/** A host context: the parts setup reads named, the rest answered by `anything`; the status RPC's handler kept. */
function fakeHost(directory: string) {
  const handlers: { status?: (input: object, helpers: { error: (...args: unknown[]) => unknown }) => Promise<Status> } = {}
  const known: Record<string, unknown> = {
    options: {},
    app: { version: "2.2.3" },
    location: { directory },
    agent: { transform: async () => disposable, list: async () => ({ data: [] }), get: async () => ({ data: { permissions: [] } }) },
    skill: { transform: async () => disposable, list: async () => ({ data: [] }) },
    rpc: {
      register: async (contract: unknown, implementation: typeof handlers) => {
        if (contract === ColabRpc) handlers.status = implementation.status
        return disposable
      },
    },
  }
  const ctx = new Proxy(known, { get: (target, key) => (typeof key === "string" && key in target ? target[key] : anything()) })
  return { ctx, handlers }
}

describe("the server part's wiring", () => {
  it("puts the hooks package F's registration could not add into status's problems, one sentence each", async () => {
    const directory = mkdtempSync(join(tmpdir(), "colab-plugin-"))
    dirs.push(directory)
    const { ctx, handlers } = fakeHost(directory)
    // A host that refuses `experimental.idle`: F reports the hook it could not register.
    const plugin = createColabPlugin({ deps: () => fakeDeps({ directory }).deps, cost: async () => ({ dispose: async () => undefined, problems: ["idle"] }) })
    const dispose = await (plugin as unknown as { setup(ctx: unknown): Promise<() => Promise<void>> }).setup(ctx)
    try {
      const status = await handlers.status!({}, { error: () => undefined })
      expect(status.problems).toEqual(["The idle cost check is off on this OpenCode version (no `experimental.idle` hook); automation and `/colab-cleanup` still work."])
    } finally {
      await dispose()
    }
  })

  it("words each kind of cost problem as one sentence", () => {
    expect(costProblem("experimental.idle")).toBe(costProblem("idle"))
    expect(costProblem("compaction")).toBe("The compaction cost hook is off on this OpenCode version; automation and `/colab-cleanup` still work.")
    expect(costProblem("The context line is off on this host.")).toBe("The context line is off on this host.")
  })
})
