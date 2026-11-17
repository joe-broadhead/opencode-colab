// Package B's Colab API client: the create LRO, the `requestId` join, Google's answers as the plugin's codes, and the
// promise that no message carries a token or a URL (design §16 row B: "Colab API client (LRO, requestId, errors →
// codes)"; §15.1 idempotency; L5).
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import { COLAB_API_ORIGIN } from "../../src/runtime/discovery.js"
import { checkConnection, isAllowedRuntimeHost } from "../../src/runtime/url.js"
import { createRuntimeFixture } from "../fakes/runtime-env.js"

const signal = () => new AbortController().signal
const code = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work
    return "no error"
  } catch (error) {
    return error instanceof ColabError ? error.code : `not a ColabError: ${String(error)}`
  }
}

describe("the Colab API client", () => {
  it("waits on the create LRO and returns the runtime it made", async () => {
    const fixture = await createRuntimeFixture({ createPolls: 2 })
    try {
      const created = await fixture.ports.colab.createRuntime("default", { runtimeId: "oc-test1", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" }, requestId: "3f1c0f4e-1111-4222-8333-944455556666", waitMs: 5_000 }, signal())
      expect(created.done).toBe(true)
      expect(created.runtime?.name).toBe("runtimes/oc-test1")
      expect(fixture.api.runtimes.has("oc-test1")).toBe(true)
      // The operation was polled, not guessed at.
      expect(fixture.api.requests.filter((request) => /operations\//.test(request.path)).length).toBeGreaterThanOrEqual(2)
    } finally {
      await fixture.close()
    }
  })

  it("stops waiting at waitMs and says the create is not done", async () => {
    const fixture = await createRuntimeFixture({ createPolls: 20 })
    try {
      const created = await fixture.ports.colab.createRuntime("default", { runtimeId: "oc-test2", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" }, requestId: "3f1c0f4e-1111-4222-8333-944455556677", waitMs: 0 }, signal())
      expect(created.done).toBe(false)
      expect(created.operation).toMatch(/^operations\//)
    } finally {
      await fixture.close()
    }
  })

  it("joins a retried create by requestId and never makes a second runtime (AIP-155)", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const input = { runtimeId: "oc-test3", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } as const, requestId: "3f1c0f4e-1111-4222-8333-944455556688", waitMs: 5_000 }
      const first = await fixture.ports.colab.createRuntime("default", input, signal())
      const retried = await fixture.ports.colab.createRuntime("default", input, signal())
      expect(first.runtime?.name).toBe("runtimes/oc-test3")
      expect(retried.done).toBe(true)
      expect(retried.runtime?.name).toBe("runtimes/oc-test3")
      expect([...fixture.api.runtimes.keys()]).toEqual(["oc-test3"])
      expect(fixture.api.joins.get(input.requestId)).toBe("oc-test3")
    } finally {
      await fixture.close()
    }
  })

  it("joins the runtime an ALREADY_EXISTS answer names, as a client-chosen id that exists", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own("oc-test4")
      const joined = await fixture.ports.colab.createRuntime("default", { runtimeId: "oc-test4", spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" }, requestId: "3f1c0f4e-1111-4222-8333-944455556699", waitMs: 5_000 }, signal())
      expect(joined.done).toBe(true)
      expect(joined.runtime?.name).toBe("runtimes/oc-test4")
    } finally {
      await fixture.close()
    }
  })

  it("maps Google's answers to the plugin's codes (L5)", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const read = () => fixture.ports.colab.listRuntimeSpecs("default", signal())
      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimespecs$/ }, { status: 429, headers: { "retry-after": "7" } }, 3)
      expect(await code(read())).toBe("RATE_LIMITED")
      await expect(read()).resolves.toBeDefined()

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimespecs$/ }, { status: 500 }, 3)
      expect(await code(read())).toBe("UNAVAILABLE")

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimespecs$/ }, { status: 403, body: { error: { code: 7, status: "PERMISSION_DENIED", message: "API is not enabled", details: [{ reason: "SERVICE_DISABLED" }] } } })
      expect(await code(read())).toBe("COLAB_API_UNAVAILABLE")

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimespecs$/ }, { status: 401 })
      expect(await code(read())).toBe("AUTH_REQUIRED")

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimes$/ }, { status: 400, body: { error: { code: 9, status: "FAILED_PRECONDITION", message: "no capacity", details: [{ reason: "CAPACITY_EXHAUSTED" }] } } })
      expect(await code(fixture.ports.colab.listRuntimes("default", signal()))).toBe("CAPACITY_UNAVAILABLE")

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimes$/ }, { status: 400, body: { error: { code: 9, status: "FAILED_PRECONDITION", message: "out of units", details: [{ reason: "COMPUTE_UNITS_EXHAUSTED" }] } } })
      expect(await code(fixture.ports.colab.listRuntimes("default", signal()))).toBe("USAGE_LIMIT")

      fixture.api.failNext({ method: "GET", path: /^v1beta\/runtimes$/ }, { status: 400, body: { error: { code: 9, status: "FAILED_PRECONDITION", message: "too many", details: [{ reason: "RUNTIME_LIMIT_REACHED" }] } } })
      expect(await code(fixture.ports.colab.listRuntimes("default", signal()))).toBe("TOO_MANY_RUNTIMES")

      expect(await code(fixture.ports.colab.getRuntime("default", "oc-missing", signal()))).toBe("RUNTIME_GONE")
      expect(await code(fixture.ports.colab.deleteRuntime("default", "oc-missing", signal()))).toBe("NOT_FOUND")
    } finally {
      await fixture.close()
    }
  })

  it("reads specs, the subscription and the runtimes with the account's own scope", async () => {
    const fixture = await createRuntimeFixture()
    try {
      expect((await fixture.ports.colab.listRuntimeSpecs("default", signal())).map((entry) => entry.key.accelerator)).toEqual(["NONE", "T4", "A100"])
      expect(await fixture.ports.colab.getSubscription("default", signal())).toBe("SUBSCRIPTION_TIER_PRO")
      expect(await fixture.ports.colab.listRuntimes("default", signal())).toEqual([])
      const answers = fixture.api.requests.filter((request) => request.path === "v1beta/runtimespecs")
      expect(answers[0]?.authorization).toBe("Bearer fake-token-default")
    } finally {
      await fixture.close()
    }
  })

  it("asks for the read-only scope on a read account and the write scope on a write one", async () => {
    const fixture = await createRuntimeFixture({ options: { accounts: { default: {}, work: { access: "read" } } } })
    try {
      await fixture.ports.colab.listRuntimeSpecs("work", signal())
      await fixture.ports.colab.listRuntimeSpecs("default", signal())
      const tokenCalls = fixture.auth.calls.filter((call) => call.method === "token").map((call) => call.args as [string, readonly string[]])
      expect(tokenCalls[0]?.[0]).toBe("work")
      expect(tokenCalls[0]?.[1][0]).toBe("https://www.googleapis.com/auth/colaboratory.readonly")
      expect(fixture.auth.calls.at(-1)?.args[0]).toBe("default")
      expect((fixture.auth.calls.at(-1)?.args[1] as string[])[0]).toBe("https://www.googleapis.com/auth/colaboratory")
    } finally {
      await fixture.close()
    }
  })

  it("never puts the access token, a URL or Google's raw text in an error", async () => {
    const fixture = await createRuntimeFixture()
    try {
      fixture.api.failNext(
        { method: "GET", path: /^v1beta\/runtimespecs$/ },
        { status: 500, body: { error: { code: 13, status: "INTERNAL", message: "boom at https://colaboratory.googleapis.com/v1beta/runtimes?requestId=fake-token-default" } } },
        3,
      )
      const failure = await fixture.ports.colab.listRuntimeSpecs("default", signal()).catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(ColabError)
      const message = (failure as ColabError).message
      expect(message).not.toContain("fake-token-default")
      expect(message).not.toContain("?requestId")
      expect(message).toMatch(/^UNAVAILABLE: /)
    } finally {
      await fixture.close()
    }
  })

  it("only ever calls the Colab API origin", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.ports.colab.listRuntimeSpecs("default", signal())
      expect(COLAB_API_ORIGIN).toBe("https://colaboratory.googleapis.com")
      expect(fixture.api.requests).toHaveLength(1)
    } finally {
      await fixture.close()
    }
  })
})

describe("the package's factory", () => {
  it("replaces the Day 0 stub: the three ports are built from one factory, and auth comes before any network call", async () => {
    const { createRuntimePorts } = await import("../../src/runtime/index.js")
    const { FakeAuth, FakeClock, MemoryLedger } = await import("../fakes/index.js")
    const { loadOptions } = await import("../../src/options.js")
    const auth = new FakeAuth()
    let called = false
    const ports = createRuntimePorts({
      options: loadOptions({}),
      directory: "/project",
      clock: new FakeClock(),
      auth,
      ledger: new MemoryLedger(),
      fetch: (async () => {
        called = true
        throw new Error("no request may leave the machine")
      }) as unknown as typeof fetch,
    })
    expect(typeof ports.colab.listRuntimes).toBe("function")
    expect(typeof ports.runtime.openSession).toBe("function")
    expect(typeof ports.check.probe).toBe("function")
    // No grant on the fake auth, so the client refuses with AUTH_REQUIRED before fetching anything: not the stub's
    // NOT_IMPLEMENTED, and no network call.
    await expect(ports.colab.listRuntimeSpecs("default", signal())).rejects.toMatchObject({ code: "AUTH_REQUIRED" })
    expect(called).toBe(false)
  })
})

describe("the runtime URL gate", () => {
  const info = (url: string, token = "proxy-token") => ({ url, token, expireTime: "2026-11-17T10:00:00Z" })

  it("accepts only https on a Google-owned host, and refuses anything else without echoing it", () => {
    expect(isAllowedRuntimeHost("abc.prod.colab.dev")).toBe(true)
    expect(isAllowedRuntimeHost("colab.dev")).toBe(true)
    expect(isAllowedRuntimeHost("evil.example.com")).toBe(false)
    expect(checkConnection(info("https://abc.prod.colab.dev/")).url.host).toBe("abc.prod.colab.dev")
    const failure = (() => {
      try {
        checkConnection(info("https://evil.example.com/"))
      } catch (error) {
        return error as ColabError
      }
    })()
    expect(failure?.code).toBe("RUNTIME_UNVERIFIED")
    expect(failure?.message).not.toContain("evil.example.com")
  })

  it("refuses a plain-http URL, a URL carrying credentials and an empty token", () => {
    expect(() => checkConnection(info("http://abc.prod.colab.dev/"))).toThrowError(ColabError)
    expect(() => checkConnection(info("https://user:secret@abc.prod.colab.dev/"))).toThrowError(ColabError)
    expect(() => checkConnection(info("https://abc.prod.colab.dev/", ""))).toThrowError(ColabError)
  })

  it("accepts a loopback origin only when the test-only option says so", () => {
    expect(() => checkConnection(info("http://127.0.0.1:8000/"))).toThrowError(ColabError)
    expect(checkConnection(info("http://127.0.0.1:8000/"), { allowLoopback: true }).url.port).toBe("8000")
  })
})
