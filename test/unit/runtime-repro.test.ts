// The reviewer's own reproductions for colab #2 (5b109fa), kept as tests so the two defects cannot come back: R1 (M3,
// a Stop on the opening call must not kill the session) and R2 (M2, a transient 503 must not taint a runtime for good).
// Package B's own tests cover the same ground by name in runtime-protocol.test.ts and runtime-agentonly.test.ts.
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import { createRuntimeFixture, RUNTIME_ID } from "../fakes/runtime-env.js"

const TARGET = { account: "default", runtimeId: RUNTIME_ID }
const fresh = () => new AbortController().signal

describe("reviewer repro, colab #2", () => {
  it("R1: after a Stop aborts the signal that opened a session, the next run on that session still works", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      const opening = new AbortController()
      await fixture.ports.runtime.openSession(TARGET, { name: "oc-nonce-1-run", path: "/content/a.ipynb" }, opening.signal)
      opening.abort() // the tool call that opened the session was stopped
      const again = await fixture.ports.runtime.openSession(TARGET, { name: "oc-nonce-1-run", path: "/content/a.ipynb" }, fresh())
      let code = "ok"
      try {
        for await (const _ of again.execute("print(1)", { allowStdin: false, silent: false, storeHistory: true }, fresh())) void _
      } catch (error) {
        code = error instanceof ColabError ? error.code : String(error)
      }
      expect(code).toBe("ok")
    } finally {
      await fixture.close()
    }
  })

  it("R2: one transient 503 from the runtime during a probe does not taint the runtime for good", async () => {
    let failNext = false
    const fixture = await createRuntimeFixture({
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        if (failNext) {
          failNext = false
          return new Response("busy", { status: 503 })
        }
        return globalThis.fetch(request as RequestInfo, init)
      }) as typeof fetch,
    })
    try {
      await fixture.own()
      const calibration = await fixture.ports.check.calibrate(TARGET, "nonce-1", fresh())
      failNext = true
      const verdict = await fixture.ports.check.probe(TARGET, { nonce: "nonce-1", calibration, fresh: true }, fresh())
      expect(verdict.ok === false ? verdict.code : "ok").toBe("RUNTIME_UNVERIFIED") // refusing is right…
      expect(fixture.ledger.runtimes.get(RUNTIME_ID)?.tainted).toBeUndefined() // …tainting for good is not
    } finally {
      await fixture.close()
    }
  })
})
