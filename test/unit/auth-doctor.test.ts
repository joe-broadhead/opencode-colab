// §14 and §4: `/colab-doctor` — one small read per account, design §14's codes, the read-only skip and the runtime
// print asserted as colab.run, and never Google's text in the message.
import { describe, expect, it } from "vitest"
import { Doctor, formatDoctor, summarizeDoctor, type DoctorRuntimeProbe } from "../../src/auth/doctor.js"
import { createAuth } from "../../src/auth/index.js"
import { SCOPES } from "../../src/auth/scopes.js"
import { loadOptions } from "../../src/options.js"
import { FakeClock } from "../fakes/index.js"
import { FakeAuthHost } from "../fakes/auth-host.js"
import { FakeHttp, storedCredential } from "../fakes/auth-http.js"

const NOW = new Date("2026-11-17T09:00:00.000Z")

function setup(
  raw: unknown,
  options: { http?: FakeHttp; probe?: DoctorRuntimeProbe; decide?: (request: { readonly action: string }) => boolean; signedIn?: boolean } = {},
) {
  const http = options.http ?? new FakeHttp()
  const config = loadOptions(raw)
  const host = new FakeAuthHost()
  if (options.signedIn !== false) {
    for (const account of config.accounts) {
      const granted = account.backend === "enterprise" ? [SCOPES.openid, SCOPES.email, SCOPES.cloudPlatform] : [SCOPES.openid, SCOPES.email, SCOPES.colaboratory, SCOPES.driveFile]
      host.credentials.set(`colab-${account.alias}`, storedCredential({ now: NOW.getTime(), granted }))
    }
  }
  const auth = createAuth({ options: config, clock: new FakeClock(NOW), host, fetch: http.fetch, env: {} })
  const asserts: { action: string; resources: readonly string[] }[] = []
  const doctor = new Doctor({
    options: config,
    auth,
    fetch: http.fetch,
    assert: async (request) => {
      asserts.push({ action: request.action, resources: request.resources })
      if (options.decide && !options.decide(request)) throw new Error("denied")
    },
    ...(options.probe ? { runtimeProbe: options.probe } : {}),
  })
  return { doctor, http, host, asserts, config }
}

const consumer = { accounts: { default: {} } }
const enterprise = { accounts: { work: { backend: "enterprise", access: "write", project: "example-project", region: "us-central1", outputBucket: "gs://example-bucket/runs" } } }

describe("/colab-doctor (design §14)", () => {
  it("§14 — a consumer account's runtimespecs.list is one read, asserted as colab.read on its operation", async () => {
    const http = new FakeHttp()
    http.on("colaboratory.googleapis.com", "/v1beta/runtimespecs", 200, { runtimeSpecs: [] })
    const { doctor, asserts } = setup(consumer, { http })
    const checks = await doctor.checks("ses_1")
    expect(checks.map((check) => [check.check, check.status])).toEqual([
      ["runtimespecs.list", "OK"],
      ["runtime print(1)", "SKIPPED"],
    ])
    expect(asserts).toEqual([{ action: "colab.read", resources: ["default:colaboratory.runtimespecs.list"] }])
    expect(http.calls[0]!.headers["authorization"]).toBe("Bearer ya29.test-access-token")
  })

  it("§14 — an Enterprise account checks templates and one bucket listing, and the message names both", async () => {
    const http = new FakeHttp()
    http.on("aiplatform.googleapis.com", "/v1/projects/example-project/locations/us-central1/notebookRuntimeTemplates", 200, {})
    http.route((url) => url.host === "storage.googleapis.com", () => new Response("{}", { status: 200 }))
    const { doctor } = setup(enterprise, { http })
    const checks = await doctor.checks("ses_1")
    expect(checks.map((check) => [check.check, check.status])).toEqual([
      ["notebookRuntimeTemplates.list", "OK"],
      ["storage.objects.list", "OK"],
      ["runtime print(1)", "SKIPPED"],
    ])
    const message = formatDoctor(checks)
    expect(message).toContain("work (enterprise) notebookRuntimeTemplates.list: OK")
    expect(message).toContain("work (enterprise) storage.objects.list: OK")
    expect(new URL(http.calls[1]!.url).searchParams.get("prefix")).toBe("runs")
  })

  it("L1 — a Colab API refusal is COLAB_API_UNAVAILABLE (the capability gate), and §14's other codes come from the HTTP answer", async () => {
    const cases: { status: number; body: unknown; expected: string }[] = [
      { status: 401, body: {}, expected: "AUTH_REQUIRED" },
      { status: 403, body: { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } }, expected: "API_DISABLED" },
      { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "colaboratory is not available" } }, expected: "COLAB_API_UNAVAILABLE" },
      { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } }, expected: "UNAVAILABLE" },
      { status: 503, body: {}, expected: "UNAVAILABLE" },
    ]
    for (const item of cases) {
      const http = new FakeHttp()
      http.route((url) => url.host === "colaboratory.googleapis.com", () => new Response(JSON.stringify(item.body), { status: item.status }))
      const { doctor } = setup(consumer, { http })
      const checks = await doctor.checks("ses_1")
      expect(checks[0]).toMatchObject({ check: "runtimespecs.list", status: item.expected })
      if (item.expected === "API_DISABLED") expect(checks[0]!.enableUrl).toContain("apiid=colaboratory.googleapis.com")
    }
  })

  it("§14 — an Enterprise IAM refusal is PERMISSION_DENIED, and a missing bucket is SKIPPED with its setting", async () => {
    const http = new FakeHttp()
    http.on("aiplatform.googleapis.com", "/v1/projects/p/locations/r/notebookRuntimeTemplates", 403, { error: { status: "PERMISSION_DENIED" } })
    const { doctor } = setup({ accounts: { work: { backend: "enterprise", project: "p", region: "r" } } }, { http })
    const checks = await doctor.checks("ses_1")
    expect(checks[0]).toMatchObject({ status: "PERMISSION_DENIED" })
    expect(checks[1]).toMatchObject({ check: "storage.objects.list", status: "SKIPPED" })
    expect(checks[1]!.next).toContain("outputBucket")
  })

  it("§14 — the bucket's 404 is its own message, and no Google text is shown", async () => {
    const http = new FakeHttp()
    http.on("aiplatform.googleapis.com", "/v1/projects/p/locations/r/notebookRuntimeTemplates", 200, {})
    http.route((url) => url.host === "storage.googleapis.com", () => new Response(JSON.stringify({ error: { code: 404 } }), { status: 404 }))
    const { doctor } = setup({ accounts: { work: { backend: "enterprise", project: "p", region: "r", outputBucket: "gs://bucket/prefix" } } }, { http })
    const checks = await doctor.checks("ses_1")
    expect(checks[1]).toMatchObject({ status: "ERROR", detail: "the bucket was not found." })
  })

  it("§14 — an account's own failures are reported before any Google call: AUTH_REQUIRED and PROJECT_REQUIRED", async () => {
    const signedOut = setup(consumer, { signedIn: false })
    const checks = await signedOut.doctor.checks("ses_1")
    expect(checks[0]).toMatchObject({ status: "AUTH_REQUIRED" })
    expect(signedOut.http.calls).toHaveLength(0)

    const http = new FakeHttp()
    const missing = setup({ accounts: { work: { backend: "enterprise", mode: "token", tokenEnv: "COLAB_TOKEN" } } }, { http })
    const outcomes = await missing.doctor.checks("ses_1")
    expect(outcomes[0]).toMatchObject({ check: "notebookRuntimeTemplates.list", status: "PROJECT_REQUIRED" })
    expect(http.calls).toHaveLength(0)
  })

  it("§14 — at read-only the runtime print is skipped and nothing is asserted for it", async () => {
    const http = new FakeHttp()
    http.on("colaboratory.googleapis.com", "/v1beta/runtimespecs", 200, {})
    const { doctor, asserts } = setup({ access: "read-only" }, { http })
    const checks = await doctor.checks("ses_1")
    const print = checks.find((check) => check.check === "runtime print(1)")!
    expect(print.status).toBe("SKIPPED")
    expect(print.detail).toContain("read-only")
    expect(asserts.map((assert) => assert.action)).not.toContain("colab.run")
  })

  it("§14 — with a runtime of ours, the print asserts colab.run on the operation and the runtime, then runs", async () => {
    const http = new FakeHttp()
    http.on("colaboratory.googleapis.com", "/v1beta/runtimespecs", 200, {})
    const printed: string[] = []
    const probe: DoctorRuntimeProbe = { runtimes: async () => ["oc-runtime-1"], print: async (_account, runtime) => void printed.push(runtime) }
    const { doctor, asserts } = setup(consumer, { http, probe })
    const checks = await doctor.checks("ses_1")
    expect(checks.find((check) => check.check === "runtime print(1)")!.status).toBe("OK")
    expect(printed).toEqual(["oc-runtime-1"])
    expect(asserts).toContainEqual({ action: "colab.run", resources: ["default:jupyter.kernels.execute", "default:runtime:oc-runtime-1"] })
  })

  it("§14 — a denied colab.run runs no code; a runtime refusal keeps its own code", async () => {
    const http = new FakeHttp()
    http.on("colaboratory.googleapis.com", "/v1beta/runtimespecs", 200, {})
    let printed = 0
    const probe: DoctorRuntimeProbe = { runtimes: async () => ["oc-runtime-1"], print: async () => void (printed += 1) }
    const denied = setup(consumer, { http, probe, decide: (request) => request.action !== "colab.run" })
    const checks = await denied.doctor.checks("ses_1")
    expect(checks.find((check) => check.check === "runtime print(1)")!.status).toBe("DENIED")
    expect(printed).toBe(0)

    const failing: DoctorRuntimeProbe = {
      runtimes: async () => ["oc-runtime-1"],
      print: async () => {
        throw Object.assign(new Error("nope"), { code: "RUNTIME_SHARED", detail: "another client's session is on the runtime.", next: "Plan a fresh runtime." })
      },
    }
    const refused = setup(consumer, { http, probe: failing })
    const outcome = await refused.doctor.checks("ses_1")
    expect(outcome.find((check) => check.check === "runtime print(1)")!.status).toBe("ERROR")
  })

  it("§14 — Google's text never reaches the message, and the summary counts OK and attention", async () => {
    const http = new FakeHttp()
    http.route(
      (url) => url.host === "colaboratory.googleapis.com",
      () => new Response(JSON.stringify({ error: { message: "<script>steal()</script> project 12345" }, hostile: "text" }), { status: 500 }),
    )
    const { doctor } = setup(consumer, { http })
    const answer = await doctor.run({ sessionID: "ses_1" })
    expect(answer.text).not.toContain("<script>")
    expect(answer.text).not.toContain("12345")
    expect(answer.text).toContain("Colab doctor")
    expect(summarizeDoctor(await doctor.checks("ses_1"))).toContain("need")
  })

  it("§14 — an Enterprise read account's cloud-platform is reported as SCOPE_WIDER_THAN_ACCESS", async () => {
    const http = new FakeHttp()
    http.on("aiplatform.googleapis.com", "/v1/projects/p/locations/r/notebookRuntimeTemplates", 200, {})
    http.route((url) => url.host === "storage.googleapis.com", () => new Response("{}", { status: 200 }))
    const { doctor } = setup({ accounts: { work: { backend: "enterprise", access: "read", project: "p", region: "r", outputBucket: "gs://b" } } }, { http })
    const checks = await doctor.checks("ses_1")
    expect(checks.find((check) => check.check === "access")).toMatchObject({ status: "SKIPPED" })
    expect(checks.find((check) => check.check === "access")!.detail).toContain("SCOPE_WIDER_THAN_ACCESS")
  })
})
