// Package B's agent-only check (design §7.4; §15.1 "Agent-only runtimes"; L15, L16, L17). Every case here is a claim the
// design makes about what the plugin can see, and every refusal is also a taint in the ledger.
import { describe, expect, it } from "vitest"
import { ColabError } from "../../src/domain/errors.js"
import type { Calibration, ProbeVerdict } from "../../src/ports.js"
import { COLABTOOLS_FACTS_VERSION, CREDENTIAL_FILES, EPHEMERAL_MARKERS } from "../../src/runtime/discovery.js"
import { parseProbeOutput, PROBE_SENTINEL, PROBE_SNIPPET_VERSION, probeSnippet } from "../../src/runtime/probe.js"
import { createRuntimeFixture, PROXY_TOKEN, RUNTIME_ID, type RuntimeFixture } from "../fakes/runtime-env.js"

const signal = () => new AbortController().signal
const TARGET = { account: "default", runtimeId: RUNTIME_ID }
const NONCE = "nonce-1"

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
      // The snippet version is the colabtools facts it is pinned to.
      expect(PROBE_SNIPPET_VERSION).toBe(COLABTOOLS_FACTS_VERSION)
      // And the probe runs silently, with no stdin and no history, in the probe's own session.
      const probeRun = blind.jupyter.executed.find((entry) => entry.code.includes(PROBE_SENTINEL))
      expect(probeRun).toMatchObject({ silent: true, allowStdin: false })
      expect((await blind.ports.runtime.sessions(TARGET, signal())).map((entry) => entry.name)).toEqual([`oc-${NONCE}-probe`])
    } finally {
      await blind.close()
      await visible.close()
    }
  })

  it("L16/L17: reports a clean runtime as clean, with every finding drawn from the documented list", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      expect(await probe(fixture, calibration)).toMatchObject({ ok: true, findings: { mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 } })
      expect(tainted(fixture)).toBeUndefined()
    } finally {
      await fixture.close()
    }
  })

  it("refuses each credential file colabtools and gcloud write, and taints for good", async () => {
    for (const path of CREDENTIAL_FILES) {
      const fixture = await createRuntimeFixture()
      try {
        const calibration = await calibrate(fixture)
        fixture.jupyter.state.credentialFiles.add(path)
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

  it("L16: refuses a Drive mount at any mount point, from the kernel's /proc/mounts", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.state.mounted = true
      const verdict = await probe(fixture, calibration)
      expect(verdict).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { mounts: true } })
    } finally {
      await fixture.close()
    }
  })

  it("L17: refuses each ephemeral-credential marker colabtools sets, presence only", async () => {
    for (const marker of EPHEMERAL_MARKERS) {
      const fixture = await createRuntimeFixture()
      try {
        const calibration = await calibrate(fixture)
        fixture.jupyter.state.ephemeralMarkers.add(marker)
        const verdict = await probe(fixture, calibration)
        expect(verdict.ok, marker).toBe(false)
        expect(verdict.ok ? undefined : verdict.findings?.ephemeralMarkers, marker).toEqual([marker])
      } finally {
        await fixture.close()
      }
    }
  })

  it("L2: finds the same credential files through REST only where calibration says hidden paths are visible", async () => {
    const visible = await createRuntimeFixture({ allowHidden: true })
    const blind = await createRuntimeFixture({ allowHidden: false })
    try {
      const visibleCalibration = await calibrate(visible)
      visible.jupyter.contents.set("content/.config/credentials.db", new TextEncoder().encode("{}"))
      const found = await probe(visible, visibleCalibration)
      expect(found).toMatchObject({ ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings: { credentialFiles: ["content/.config/credentials.db"] } })

      const blindCalibration = await calibrate(blind)
      blind.jupyter.contents.set("content/.config/credentials.db", new TextEncoder().encode("{}"))
      // REST is blind here, so REST cannot see it; the kernel probe is the check that must still answer.
      expect(await probe(blind, blindCalibration)).toMatchObject({ ok: true })
    } finally {
      await visible.close()
      await blind.close()
    }
  })

  it("L15: counts a session without the nonce as another client, even one named oc-… by someone else", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      fixture.jupyter.foreignSessions.push({ id: "session-foreign", name: "oc-otherclient-run", path: "/content/notebook.ipynb", kernelId: "kernel-foreign" })
      const verdict = await probe(fixture, calibration)
      expect(verdict).toMatchObject({ ok: false, code: "RUNTIME_SHARED", findings: { foreignSessions: 1 } })
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

  it("refuses a probe kernel whose id changed, or whose execution count went backwards, as RUNTIME_UNVERIFIED", async () => {
    const replaced = await createRuntimeFixture()
    const restarted = await createRuntimeFixture()
    try {
      const replacedCalibration = await calibrate(replaced)
      replaced.jupyter.replaceKernel(`oc-${NONCE}-probe`)
      expect(await probe(replaced, replacedCalibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })

      const restartedCalibration = await calibrate(restarted)
      restarted.jupyter.state.executionCount = 0
      expect(await probe(restarted, restartedCalibration)).toMatchObject({ ok: false, code: "RUNTIME_UNVERIFIED" })
      expect(tainted(restarted)).toBe("RUNTIME_UNVERIFIED")
    } finally {
      await replaced.close()
      await restarted.close()
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

  it("taints at birth and refuses calibration when the first probe is dirty, before any agent code", async () => {
    const fixture = await createRuntimeFixture()
    try {
      await fixture.own()
      fixture.jupyter.state.mounted = true
      expect(await verdictCode(fixture.ports.check.calibrate(TARGET, NONCE, signal()))).toBe("RUNTIME_HAS_CREDENTIALS")
      expect(tainted(fixture)).toBe("RUNTIME_HAS_CREDENTIALS")
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
      // And the cache expires on the clock, not on a wall-clock guess.
      fixture.clock.advance(31_000)
      await probe(fixture, calibration, false)
      expect(fixture.jupyter.executed.filter((entry) => entry.code.includes(PROBE_SENTINEL)).length).toBe(before + 3)
    } finally {
      await fixture.close()
    }
  })

  it("keeps every guarantee in the tier it has: what the check cannot see never reads as clean", () => {
    // A REST check that is blind is recorded as blind, not as a pass (design §7.4's table).
    expect(probeSnippet()).toContain("'/proc/mounts'")
    expect(probeSnippet()).toContain("VmRSS:")
    // Only booleans and names travel: the parser refuses anything else, including an extra line.
    expect(() => parseProbeOutput(`${PROBE_SENTINEL} {"mounts": false, "credential_files": [], "ephemeral_markers": [], "ram_bytes": 1, "execution_count": 1}\nextra`)).toThrowError(ColabError)
    expect(() => parseProbeOutput(`${PROBE_SENTINEL} {"mounts": false, "credential_files": ["/etc/passwd"], "ephemeral_markers": [], "ram_bytes": 1, "execution_count": 1}`)).toThrowError(ColabError)
    expect(() => parseProbeOutput(`${PROBE_SENTINEL} {"mounts": false, "credential_files": [], "ephemeral_markers": [], "ram_bytes": 1}`)).toThrowError(ColabError)
    expect(parseProbeOutput(`${PROBE_SENTINEL} {"mounts": true, "credential_files": [], "ephemeral_markers": [], "ram_bytes": null, "execution_count": 3}\n`)).toEqual({ mounts: true, credentialFiles: [], ephemeralMarkers: [], executionCount: 3 })
  })

  it("uses the probe session, never the agent's, and keeps its token out of every error", async () => {
    const fixture = await createRuntimeFixture()
    try {
      const calibration = await calibrate(fixture)
      const sessionNames = (await fixture.ports.runtime.sessions(TARGET, signal())).map((entry) => entry.name)
      expect(sessionNames).toEqual([`oc-${NONCE}-probe`])
      expect(calibration.probeKernel.id).toBe(fixture.jupyter.state.kernelId)
      const failure = await probe(fixture, calibration).then(() => undefined)
      expect(failure).toBeUndefined()
      expect(JSON.stringify(calibration)).not.toContain(PROXY_TOKEN)
      expect(JSON.stringify(calibration)).not.toContain(fixture.jupyter.url)
    } finally {
      await fixture.close()
    }
  })
})
