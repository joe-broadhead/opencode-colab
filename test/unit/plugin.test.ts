// The server part's wiring, on a fake host context: setup completes on a host that offers nothing beyond the parts
// it reads, and status answers from the registered tools and rules alone.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createColabPlugin } from "../../src/plugin.js"
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
    app: { version: "2.4.1" },
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
  it("completes setup and answers status with no problems", async () => {
    const directory = mkdtempSync(join(tmpdir(), "colab-plugin-"))
    dirs.push(directory)
    const { ctx, handlers } = fakeHost(directory)
    const plugin = createColabPlugin({ deps: () => fakeDeps({ directory }).deps })
    const dispose = await (plugin as unknown as { setup(ctx: unknown): Promise<() => Promise<void>> }).setup(ctx)
    try {
      const status = await handlers.status!({}, { error: () => undefined })
      expect(status).toMatchObject({ access: "all", host: { version: "2.4.1", tested: true } })
      expect(status.problems).toBeUndefined()
      expect(status.tools).toEqual({ registered: 20 })
    } finally {
      await dispose()
    }
  })
})
