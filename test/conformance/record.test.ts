/**
 * The conformance recorder: drives the plugin's real handler table with the in-memory provider, then writes
 * `fixtures/conformance.json`. `plugin-kit record` replays and redacts the file; this test invents nothing about the
 * kit.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"
import { resolveAccount } from "@we-the-rebel-alliance/plugin-contract/accounts"
import type { MethodCall } from "@we-the-rebel-alliance/plugin-contract/register"
import { accountsFor } from "../../src/accounts.js"
import { createHandlers } from "../../src/handlers/index.js"
import { manifest, pkg, version } from "../../src/manifest.js"
import { accountSignal } from "../../src/handlers/status.js"
import { fakeDeps, type Fakes } from "../fakes/index.js"
import type { RunRecord, RuntimeRecord } from "../../src/provider/ports.js"

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const NOW = "2026-11-21T09:00:00.000Z"
/** A fixed local owner: the ledger source names this computer, and a fixture must be the same everywhere. */
const FIXTURE_OWNER = { id: "os-user:recorded@fixture", label: "recorded on fixture" }

const runtime = (id: string, account: string): RuntimeRecord => ({
  id,
  account,
  backend: "colab",
  spec: { variant: "VARIANT_GPU", shape: "SHAPE_STANDARD", accelerator: "T4" },
  createdAt: "2026-11-21T08:00:00.000Z",
  nonce: "0123456789abcdef0123456789abcdef",
  keep: ["/content/outputs/**"],
  lease: { releaseAfterIdleMinutes: 20, maxHours: 4 },
  state: "ready",
})

const run = (runId: string, account: string, runtimeId: string): RunRecord => ({
  runId,
  account,
  backend: "colab",
  state: "ok",
  runtime: runtimeId,
  spec: "T4 GPU",
  startedAt: "2026-11-21T08:10:00.000Z",
  endedAt: "2026-11-21T08:12:30.000Z",
  cellIds: ["cell-1", "cell-2"],
  outputPaths: [],
  notebook: "analysis.ipynb",
})

interface Emitted {
  readonly name: string
  readonly data: unknown
}

function call(account: string, emitted: Emitted[]): MethodCall {
  return {
    sessionID: "ses_record",
    agent: "build",
    messageID: "msg_record",
    id: "call_record",
    signal: new AbortController().signal,
    progress: async () => undefined,
    account,
    bus: {
      emit: async (name: string, data: unknown) => {
        emitted.push({ name, data })
        return { ok: true as const }
      },
    },
    access: { rules: [] },
    unguardedAgents: async () => [],
    door: "rpc",
  } as unknown as MethodCall
}

async function seed(fakes: Fakes): Promise<void> {
  const work = runtime("oc-work", "work")
  const personal = runtime("oc-personal", "personal")
  await fakes.ledger.putRuntime(work)
  await fakes.ledger.putRuntime(personal)
  await fakes.ledger.putRun(run("run-work-1", "work", work.id))
  await fakes.ledger.putRun(run("run-personal-1", "personal", personal.id))
  fakes.auth.grants.set("work", ["https://www.googleapis.com/auth/colaboratory"])
  fakes.auth.grants.set("personal", ["https://www.googleapis.com/auth/colaboratory.readonly"])
  fakes.colab.runtimes.set("oc-work", { name: `runtimes/${work.id}`, spec: work.spec })
  fakes.colab.runtimes.set("oc-personal", { name: `runtimes/${personal.id}`, spec: personal.spec })
}

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  try {
    await work()
    return "ok"
  } catch (error) {
    return typeof error === "object" && error !== null && "refusal" in error ? ((error as { refusal: { code: string } }).refusal.code ?? "unknown") : "unknown"
  }
}

describe("conformance recording", () => {
  test("records two accounts, both sources, status and the changed event", async () => {
    const rawOptions = { access: "all", accounts: { work: { access: "write" }, personal: { access: "write" } } }
    const { deps, fakes } = fakeDeps({ options: rawOptions })
    fakes.clock.current = new Date(NOW)
    await seed(fakes)
    const profiles = accountsFor(manifest, rawOptions)
    const handlers = createHandlers({ deps, manifest, version, hostVersion: "2.4.1", profiles, problems: [] })
    const emitted: Emitted[] = []

    const workPage = (await handlers.events_list!.run({ source: "runs" }, call("work", emitted))) as {
      cursor: string
      account: string
      source: string
      events: readonly unknown[]
    }
    const personalPage = (await handlers.events_list!.run({ source: "runs" }, call("personal", emitted))) as { cursor: string }
    const fixed = { ...(workPage as unknown as Record<string, unknown>), owner: FIXTURE_OWNER }
    const required = resolveAccount(profiles.map((profile) => ({ alias: profile.alias })), {})
    const unknown = resolveAccount(profiles.map((profile) => ({ alias: profile.alias })), { account: "nobodyhere" })
    const crossed = await codeOf(async () => handlers.events_list!.run({ source: "runs", cursor: workPage.cursor }, call("personal", emitted)))

    const probeRuns = await handlers.probe!.run({ source: "runs" }, call("work", emitted))
    const probeRuntimes = await handlers.probe!.run({ source: "runtimes" }, call("work", emitted))
    const snapshot = await handlers.runtimes_read!.run({ source: "runtimes" }, call("work", emitted))
    const status = await handlers.status!.run({}, call("default", emitted))

    const cleanup = (await handlers.cleanup!.run({}, call("work", emitted))) as { released: readonly string[] }
    expect(cleanup.released).toEqual(["oc-work"])
    expect(emitted.some((event) => event.name === "changed")).toBe(true)

    expect(required.ok).toBe(false)
    expect(unknown.ok).toBe(false)
    expect(crossed).toBe("CURSOR_INVALID")
    expect(workPage.source).toBe("runs")
    expect(workPage.account).toBe("work")

    const signals: Record<string, Awaited<ReturnType<typeof accountSignal>>> = {}
    for (const profile of profiles) signals[profile.alias] = await accountSignal(deps, profile)
    expect(signals.work?.state).toBe("ready")

    const fixture = {
      $comment: "Recorded from the plugin's own handlers over the in-memory provider: two synthetic accounts, both sources, a write that emits changed, and the strict status. No Google account is involved.",
      plugin: pkg.name,
      namespace: manifest.plugin.summary,
      accounts: {
        real: true,
        aliases: profiles.map((profile) => profile.alias),
        required: { method: "events_list", code: required.ok ? "ok" : required.code },
        unknown: { method: "events_list", account: "nobodyhere", code: unknown.ok ? "ok" : unknown.code },
        cursors: [{ method: "events_list", account: "work", other: "personal", code: crossed }],
      },
      sources: {
        "colab.runs": {
          cases: [
            { input: { source: "runs" }, expect: "page", answer: fixed },
            { input: { source: "runs" }, expect: "page", answer: { ...(personalPage as unknown as Record<string, unknown>), owner: FIXTURE_OWNER } },
          ],
          probe: { answer: probeRuns },
        },
        "colab.runtimes": {
          snapshot: { answer: snapshot },
          probe: { answer: probeRuntimes },
        },
      },
      events: {
        emitted: [...new Set(emitted.map((event) => event.name))].sort(),
        status,
      },
      rpc: {
        inputs: {
          edit: { path: "analysis.ipynb", ifHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000", ops: [{ op: "clearOutputs" }] },
          run: { runtime: "oc-test", code: "print(1)" },
          cancel: { runId: "run-test" },
          upload: { runtime: "oc-test", path: "data.csv" },
          download: { runtime: "oc-test", path: "/content/data.csv" },
          pause: { schedule: "projects/p/locations/l/schedules/1" },
          cleanup: {},
          plan_write: { action: "runtime.create", params: { spec: { variant: "VARIANT_CPU", shape: "SHAPE_STANDARD", accelerator: "NONE" } } },
          plan_delete: { action: "runtime.delete", params: { runtime: "oc-test" } },
        },
      },
    }
    mkdirSync(join(ROOT, "fixtures"), { recursive: true })
    writeFileSync(join(ROOT, "fixtures/conformance.json"), `${JSON.stringify(fixture, null, 2)}\n`)
  })
})
