// Package B's agent-only check (design §7.4; §15.1 "Agent-only runtimes"; L15, L16, L17; review round 4 H1, M1, M2,
// M5). Every case is a claim the design makes about what the plugin can see, and a finding is also a taint.
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { Calibration, ProbeVerdict } from "../../src/ports.js"
import { COLABTOOLS_FACTS_VERSION, CREDENTIAL_FILES, GCLOUD_CONFIG_MARKER } from "../../src/runtime/discovery.js"
import { GCLOUD_GCE_MARKER } from "../../src/runtime/probe.js"
import { createOwnerLease } from "../../src/runtime/lease.js"
import { parseBaselineOutput, parseComparisonOutput, PROBE_SENTINEL, PROBE_SNIPPET_VERSION, probeSnippet } from "../../src/runtime/probe.js"
import type { RuntimeProtocolInternal } from "../../src/runtime/protocol.js"
import { createRuntimeFixture, PROXY_TOKEN, RUNTIME_ID, type RuntimeFixture } from "../fakes/runtime-env.js"

const signal = () => new AbortController().signal
const TARGET = { account: "default", runtimeId: RUNTIME_ID }
const NONCE = "nonce-1"
const DRIVE = "drive|/content/drive|fuse.drive"

const calibrate = async (fixture: RuntimeFixture): Promise<Calibration> => {
  await fixture.own()
  return fixture.ports.check.calibrate(TARGET, NONCE, signal())
}

const probe = async (fixture: RuntimeFixture, calibration: Calibration, fresh = true): Promise<ProbeVerdict> => fixture.ports.check.probe(TARGET, { nonce: NONCE, calibration, fresh }, signal())

const verdictCode = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work
    return "no error"
  } catch (error) {
    return error instanceof ColabError ? error.code : String(error)
  }
}

const tainted = (fixture: RuntimeFixture) => fixture.ledger.runtimes.get(RUNTIME_ID)?.tainted?.code

describe("the agent-only check", () => {
  it("H1: a stock Colab runtime — its ephemeral-credential addresses, container FUSE mounts and gcloud config — probes clean", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true, findings: { mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 } })
      expect(tainted(fixture)).toBeUndefined()
      // The fake carries Colab's real stock environment; the probe must not consult it (H1: presence is not evidence).
      expect(Object.keys(fixture.jupyter.state.environment)).toContain("TBE_EPHEM_CREDS_ADDR")
      const snippet = probeSnippet({ mode: "compare", epoch: "x" })
      for (const name of Object.keys(fixture.jupyter.state.environment)) expect(snippet).not.toContain(name)
    } finally {
      await fixture.close()
    }
  })

  it("L2: calibrates whether REST can see hidden paths, the proxy's baseline, and the probe kernel's first round trip", async () => {
    const blind = await createRuntimeFixture({ allowHidden: false })
    const visible = await createRuntimeFixture({ allowHidden: true })
    try {
      const blindCalibration = await calibrate(blind)
      const visibleCalibration = await calibrate(visible)
      expect(blindCalibration.hiddenPathsVisible).toBe(false)
      expect(visibleCalibration.hiddenPathsVisible).toBe(true)
      expect(Object.values(blindCalibration.baselineConnections)).toEqual([1])
      expect(blindCalibration.probeKernel.id).toBe(blind.jupyter.state.kernelId)
      expect(blindCalibration.probeKernel.executionCount).toBe(1)
      expect(blindCalibration.probeKernel.startMs).toBeGreaterThanOrEqual(0)
      expect(blindCalibration.probeKernel.rttMs).toBeGreaterThanOrEqual(0)
      expect(blindCalibration.snippetVersion).toBe(PROBE_SNIPPET_VERSION)
      expect(PROBE_SNIPPET_VERSION).toBe(COLABTOOLS_FACTS_VERSION)
      const probeRun = blind.jupyter.executed.find((entry) => entry.code.includes(PROBE_SENTINEL))
      expect(probeRun).toMatchObject({ silent: true, allowStdin: false })
      expect((await blind.ports.runtime.sessions(TARGET, signal())).map((entry) => entry.name)).toEqual([`oc-${NONCE}-probe`])
    } finally {
      await blind.close()
      await visible.close()
    }
  })

  it("H1: each credential file that appears after calibration is a finding, and taints for good", async () => {
    for (const path of CREDENTIAL_FILES) {
      const fixture = await createRuntimeFixture()
      try {
        const calibration = await calibrate(fixture)
        fixture.jupyter.contents.set(path, new TextEncoder().encode("{}"))
        const verdict = await probe(fixture, calibration)
        expect(verdict.ok, path).toBe(false)
        expect(verdict.ok ? undefined : verdict.code, path).toBe("RUNTIME_HAS_CREDENTIALS")
        expect(verdict.ok ? undefined : verdict.findings?.credentialFiles, path).toEqual([path])
        expect(tainted(fixture), path).toBe("RUNTIME_HAS_CREDENTIALS")
      } finally {
        await fixture.close()
      }
    }
  })

  it("H1: a credential file already present at calibration taints at birth, before any agent code", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      fixture.jupyter.contents.set("content/.adc/adc.json", new TextEncoder().encode("{}"))
      expect(await verdictCode(fixture.ports.check.calibrate(TARGET, NONCE, signal()))).toBe("RUNTIME_HAS_CREDENTIALS")
      expect(tainted(fixture)).toBe("RUNTIME_HAS_CREDENTIALS")
    } finally {
      await fixture.close()
    }
  })

  it("L16: a Drive mount at any mount point is a finding, a stock container FUSE mount is not", async () => {
    const after = await createRuntimeFixture()
    const atBirth = await createRuntimeFixture()
    try {
      const calibration = await calibrate(after)
      expect(after.jupyter.state.mounts.some((entry) => entry.includes("fuse.lxcfs"))).toBe(true)
      after.jupyter.state.mounts.push(DRIVE)
      expect(await probe(after, calibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { mounts: true } })

      await atBirth.own()
      atBirth.jupyter.state.mounts.push(DRIVE)
      expect(await verdictCode(atBirth.ports.check.calibrate(TARGET, NONCE, signal()))).toBe("RUNTIME_HAS_CREDENTIALS")
    } finally {
      await after.close()
      await atBirth.close()
    }
  })

  it("H1: a mount that appears after calibration is a finding, even when it is not a Drive mount", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.state.mounts.push("server:/export|/mnt/share|nfs")
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { mounts: true } })
    } finally {
      await fixture.close()
    }
  })

  it("L17: ephemeral auth's one observable trace — gcloud's config changing — is the marker, never an environment variable", async () => {
    const fixture = await createRuntimeFixture()
    try {
      // A stock runtime can carry a `gce` file; its disappearance is what `_enable_metadata_server_for_gcloud` does, and
      // it is its own signal — its creation is not one (review M-C).
      fixture.jupyter.contents.set("content/.config/gce", new TextEncoder().encode("{}"))
      const calibration = await calibrate(fixture)
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true })
      fixture.jupyter.contents.delete("content/.config/gce")
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { ephemeralMarkers: [GCLOUD_GCE_MARKER] } })
      // Its creation, on a fresh runtime, is not a finding.
      const created = await createRuntimeFixture()
      try {
        const freshCalibration = await calibrate(created)
        created.jupyter.contents.set("content/.config/gce", new TextEncoder().encode("{}"))
        expect(await probe(created, freshCalibration)).toMatchObject({ ok: true })
        // And an edit to the nested configurations/config_default is the config-changed signal.
        created.jupyter.contents.set("content/.config/configurations/config_default", new TextEncoder().encode("[core]\nproject = ephemeral\n"))
        expect(await probe(created, freshCalibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { ephemeralMarkers: [GCLOUD_CONFIG_MARKER] } })
      } finally {
        await created.close()
      }
    } finally {
      await fixture.close()
    }
  })

  it("H1 (round 5): ephemeral auth's edit to gcloud's nested configurations/config_default is caught", async () => {
    const fixture = await createRuntimeFixture()
    const encoder = new TextEncoder()
    try {
      // The reviewer's sandbox: a stock gcloud config with its files one level down.
      fixture.jupyter.contents.set("content/.config/configurations/config_default", encoder.encode("[core]\nproject = stock\n"))
      fixture.jupyter.contents.set("content/.config/access_tokens.db", encoder.encode("sqlite-stock"))
      const calibration = await calibrate(fixture)
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true })
      // The grant rewrites the nested file; every top-level name and size stays the same, so only a recursive digest
      // of names, sizes and content hashes sees it.
      fixture.jupyter.contents.set("content/.config/configurations/config_default", encoder.encode("[core]\nproject = ephemeral\n"))
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { ephemeralMarkers: [GCLOUD_CONFIG_MARKER] } })
    } finally {
      await fixture.close()
    }
  })

  it("H1 (round 5): a nested file that appears under gcloud's config is a finding too", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.contents.set("content/.config/configurations/config_default", new TextEncoder().encode("[core]\n"))
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { ephemeralMarkers: [GCLOUD_CONFIG_MARKER] } })
    } finally {
      await fixture.close()
    }
  })

  it("M-C: gcloud's own bookkeeping — a log, a .last_* stamp, config_sentinel — is not a finding", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.contents.set("content/.config/logs/2026.11.17/18.00.00.000000.log", new TextEncoder().encode("Running [gcloud.version]\n"))
      fixture.jupyter.contents.set("content/.config/.last_update_check.json", new TextEncoder().encode("{}"))
      fixture.jupyter.contents.set("content/.config/.last_survey_prompt.yaml", new TextEncoder().encode("{}"))
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true })
    } finally {
      await fixture.close()
    }
  })

  it("M-C: an 8 MiB scoped file answers within the probe budget", async () => {
    const fixture = await createRuntimeFixture()
    try {
      // Scoped and large, but not a credential file: only the config digest sees it, and it must stay within budget.
      fixture.jupyter.contents.set("content/.config/configurations/big.json", new Uint8Array(8 * 1024 * 1024))
      const calibration = await calibrate(fixture)
      const started = Date.now()
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true })
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      await fixture.close()
    }
  })

  it("M-C: a config past the 500-file cap is refused as RUNTIME_UNVERIFIED and does not taint", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      for (let index = 0; index < 501; index += 1) fixture.jupyter.contents.set(`content/.config/configurations/extra-${index}.json`, new TextEncoder().encode("{}"))
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
      expect(tainted(fixture)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it("M-C: a scoped tree deeper than 4 is refused as RUNTIME_UNVERIFIED and does not taint", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.contents.set("content/.config/configurations/a/b/c/d/deep.json", new TextEncoder().encode("{}"))
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
      expect(tainted(fixture)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it("L2: a credential file is refused whether or not REST can see hidden paths, because the probe kernel sees the runtime", async () => {
    for (const allowHidden of [true, false]) {
      const fixture = await createRuntimeFixture({ allowHidden })
      try {
        const calibration = await calibrate(fixture)
        fixture.jupyter.contents.set("content/.config/credentials.db", new TextEncoder().encode("{}"))
        expect(await probe(fixture, calibration), `allowHidden=${allowHidden}`).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS" })
      } finally {
        await fixture.close()
      }
    }
  })

  it("L15: counts a session without the nonce as another client, even one named oc-… by someone else", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.foreignSessions.push({ id: "session-foreign", name: "oc-otherclient-run", path: "/content/notebook.ipynb", kernelId: "kernel-foreign" })
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_SHARED", findings: { foreignSessions: 1 } })
      expect(tainted(fixture)).toBe("RUNTIME_SHARED")
    } finally {
      await fixture.close()
    }
  })

  it("L15: counts a connection beyond the baseline and the plugin's own sockets as another client", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.extraConnections = 1
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_SHARED", findings: { extraConnections: 1 } })
    } finally {
      await fixture.close()
    }
  })

  it("M1: a restarted probe kernel is RUNTIME_UNVERIFIED, because its baseline and epoch are gone", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.restartProbeKernel()
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
      expect(tainted(fixture)).toBe("RUNTIME_UNVERIFIED")
    } finally {
      await fixture.close()
    }
  })

  it("M1: a replaced probe kernel (a new kernel id) is RUNTIME_UNVERIFIED", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.replaceKernel(`oc-${NONCE}-probe`)
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
    } finally {
      await fixture.close()
    }
  })

  it("R2 (M2): one transient 503 refuses with RUNTIME_UNVERIFIED and taints nothing; the next probe works", async () => {
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
      const calibration = await calibrate(fixture)
      failNext = true
      const verdict = await probe(fixture, calibration)
      expect(verdict.ok ? "ok" : verdict.code).toBe("RUNTIME_UNVERIFIED")
      expect(tainted(fixture)).toBeUndefined()
      // Nothing was cached from the failure: the runtime is usable on the next probe.
      expect(await probe(fixture, calibration, false)).toMatchObject({ ok: true })
    } finally {
      await fixture.close()
    }
  })

  it("M5: a second OpenCode process is RUNTIME_BUSY at the check, not a taint", async () => {
    const leaseDir = mkdtempSync(join(tmpdir(), "colab-check-lease-"))
    const fixture = await createRuntimeFixture({ leaseDir })
    try {
      const calibration = await calibrate(fixture)
      const other = createOwnerLease({ dir: leaseDir, pid: process.ppid })
      const otherCheck = (await import("../../src/runtime/agentonly.js")).createAgentOnlyCheck(fixture.env, fixture.ports.runtime as RuntimeProtocolInternal, { lease: other })
      expect(await verdictCode(otherCheck.probe(TARGET, { nonce: NONCE, calibration, fresh: true }, signal()))).toBe("RUNTIME_BUSY")
      expect(tainted(fixture)).toBeUndefined()
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true })
      other.dispose()
    } finally {
      await fixture.close()
      rmSync(leaseDir, { recursive: true, force: true })
    }
  })

  it("refuses a probe whose output does not parse, and never reads it as clean", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.probeExtraOutput = "a warning nobody asked for\n"
      expect(await probe(fixture, calibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
      expect(tainted(fixture)).toBe("RUNTIME_UNVERIFIED")
    } finally {
      await fixture.close()
    }
  })

  it("reuses a clean answer for 30 s and re-reads on fresh", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      const before = fixture.jupyter.executed.filter((entry) => entry.code.includes(PROBE_SENTINEL)).length
      await probe(fixture, calibration, false)
      await probe(fixture, calibration, false)
      expect(fixture.jupyter.executed.filter((entry) => entry.code.includes(PROBE_SENTINEL)).length).toBe(before + 1)
      await probe(fixture, calibration, true)
      expect(fixture.jupyter.executed.filter((entry) => entry.code.includes(PROBE_SENTINEL)).length).toBe(before + 2)
      fixture.clock.advance(31_000)
      await probe(fixture, calibration, false)
      expect(fixture.jupyter.executed.filter((entry) => entry.code.includes(PROBE_SENTINEL)).length).toBe(before + 3)
    } finally {
      await fixture.close()
    }
  })

  it("keeps every guarantee in the tier it has: what the check cannot see never reads as clean", () => {
    const baseline = { mode: "baseline", epoch: "e", drive_mount: false, files: [], execution_count: 1, ram_bytes: 1024, gce_present: false, bounded: true }
    const comparison = { mode: "compare", epoch: "e", epoch_ok: true, restarted: false, drive_mount: false, mounts_changed: false, config_changed: false, gce_removed: false, bounded: true, added_files: [], execution_count: 1 }
    // Only booleans and known names travel: an extra line, an unknown file or a wrong key refuses.
    expect(() => parseBaselineOutput(`${PROBE_SENTINEL} ${JSON.stringify(baseline)}\nextra`)).toThrowError(ColabError)
    expect(() => parseBaselineOutput(`${PROBE_SENTINEL} ${JSON.stringify({ ...baseline, files: ["/etc/passwd"] })}`)).toThrowError(ColabError)
    expect(() => parseBaselineOutput(`${PROBE_SENTINEL} ${JSON.stringify({ ...baseline, extra: 1 })}`)).toThrowError(ColabError)
    expect(parseBaselineOutput(`${PROBE_SENTINEL} ${JSON.stringify(baseline)}\n`)).toMatchObject({ epoch: "e", executionCount: 1, ramBytes: 1024 })
    expect(() => parseComparisonOutput(`${PROBE_SENTINEL} ${JSON.stringify({ ...comparison, epoch_ok: "yes" })}`)).toThrowError(ColabError)
    expect(parseComparisonOutput(`${PROBE_SENTINEL} ${JSON.stringify({ ...comparison, added_files: ["content/.adc/adc.json"] })}\n`)).toMatchObject({ addedFiles: ["content/.adc/adc.json"] })
    // An ephemeral grant the runtime's filesystem, mounts and gcloud config do not show is not observable here.
    expect(probeSnippet({ mode: "compare", epoch: "e" })).not.toContain("os.environ")
  })

  it("uses the probe session, never the agent's, and keeps its token out of every error", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      expect((await fixture.ports.runtime.sessions(TARGET, signal())).map((entry) => entry.name)).toEqual([`oc-${NONCE}-probe`])
      expect(calibration.probeKernel.id).toBe(fixture.jupyter.state.kernelId)
      expect(JSON.stringify(calibration)).not.toContain(PROXY_TOKEN)
      expect(JSON.stringify(calibration)).not.toContain(fixture.jupyter.url)
    } finally {
      await fixture.close()
    }
  })
})
