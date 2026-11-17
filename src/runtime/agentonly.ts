/**
 * The agent-only check (design §7.4; package B owns it). It answers one question before and after every run: has
 * anything the plugin cannot vouch for appeared on this runtime of the plugin's own?
 *
 * **Calibration**, on the fresh runtime before any agent code: whether REST can see hidden paths, every kernel's
 * connection count as a baseline, and the probe kernel's first clean round trip (its id, the kernel's execution count,
 * how long it took to start and to answer, and its memory). The probe kernel is started here and is never restarted; a
 * later id change, a dead kernel or an execution count that goes backwards is RUNTIME_UNVERIFIED.
 *
 * **The probe**, before and after each run (cached 30 s; `fresh` skips the cache): the kernel-side snippet in
 * `probe.ts` (mounts, the credential files colabtools and gcloud write, the ephemeral-auth markers — booleans and names
 * only), the REST cross-check of the same paths where calibration says REST can see them plus `content/drive`,
 * sessions whose name lacks the runtime's nonce, and kernels carrying more connections than the baseline plus the
 * plugin's own sockets.
 *
 * Any finding refuses the run and **taints the runtime for good** in the ledger, with the code the finding deserves; a
 * probe that cannot complete or whose answer does not parse refuses as RUNTIME_UNVERIFIED and taints too, so
 * "unverified" never reads as "clean". This is best effort by construction: the check shares the runtime with the
 * agent's code, which runs as root and may act between probes — the guarantee's wording and limits are the ones in
 * docs/v1-design.md, and nothing here claims more.
 */
import { ColabError } from "../domain/errors.js"
import type { PortEnv } from "../deps.js"
import type { AgentOnlyCheck, Calibration, KernelSession, ProbeFindings, ProbeVerdict, RuntimeTarget } from "../ports.js"
import { CREDENTIAL_FILES, DRIVE_MOUNT_PATH, HIDDEN_PATHS_PROBE } from "./discovery.js"
import { parseProbeOutput, probeSnippet, PROBE_SNIPPET_VERSION, type ProbeOutput } from "./probe.js"
import type { RuntimeProtocolInternal } from "./protocol.js"

/** The probe's answer is reused for this long across calls (design §7.4 step 3). */
const CACHE_MS = 30_000
/** The probe session's own name, after the nonce. */
const PROBE_SESSION = "probe"
/** The file name the probe session is opened against; a session needs a path, and nothing writes to it. */
const PROBE_PATH = "oc-probe.ipynb"

/** Which folder holds which credential artefact, for the REST cross-check. */
const CREDENTIAL_FOLDERS: Readonly<Record<string, readonly string[]>> = CREDENTIAL_FILES.reduce<Record<string, string[]>>((folders, path) => {
  const cut = path.lastIndexOf("/")
  const folder = path.slice(0, cut)
  const name = path.slice(cut + 1)
  folders[folder] = [...(folders[folder] ?? []), name]
  return folders
}, {})

export interface AgentOnlyCheckOptions {
  readonly probeTimeoutSeconds: number
  readonly probeKernelStartSeconds: number
  readonly cacheMs?: number
}

interface KernelAnswer {
  readonly output: ProbeOutput
  readonly kernelId: string
  readonly rttMs: number
  readonly startMs: number
}

export function createAgentOnlyCheck(env: PortEnv, protocol: RuntimeProtocolInternal, overrides: Partial<AgentOnlyCheckOptions> = {}): AgentOnlyCheck {
  const probeTimeoutSeconds = overrides.probeTimeoutSeconds ?? env.options.probeTimeoutSeconds
  const probeKernelStartSeconds = overrides.probeKernelStartSeconds ?? env.options.probeKernelStartSeconds
  const cacheMs = overrides.cacheMs ?? CACHE_MS
  const cache = new Map<string, { readonly at: number; readonly verdict: ProbeVerdict }>()
  const probeSessions = new Map<string, KernelSession>()
  const now = () => env.clock.now().getTime()

  /** Runs `work` under a deadline of our own and under the caller's signal. */
  async function withDeadline<T>(seconds: number, signal: AbortSignal, what: string, work: (inner: AbortSignal) => Promise<T>): Promise<T> {
    if (signal.aborted) throw new ColabError("CANCELLED")
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener("abort", onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(), Math.max(1, seconds) * 1000)
    try {
      return await work(controller.signal)
    } catch (error) {
      if (signal.aborted) throw new ColabError("CANCELLED")
      if (controller.signal.aborted) throw new ColabError("RUNTIME_UNVERIFIED", `The ${what} did not answer within ${seconds} s.`)
      throw error
    } finally {
      clearTimeout(timer)
      signal.removeEventListener("abort", onAbort)
    }
  }

  /** Runs the snippet in the probe kernel and reads its one line. */
  async function kernelProbe(target: RuntimeTarget, nonce: string, signal: AbortSignal, startBudget: boolean): Promise<KernelAnswer> {
    const name = `oc-${nonce}-${PROBE_SESSION}`
    const started = now()
    const opened = probeSessions.get(target.runtimeId) ?? (await protocol.openSession(target, { name, path: PROBE_PATH }, signal))
    probeSessions.set(target.runtimeId, opened)
    if (!opened.session.name.startsWith(`oc-${nonce}-`)) throw new ColabError("RUNTIME_SHARED", "The probe's kernel session was not the plugin's own.")
    // The live session list, not the handle: a kernel that died and was replaced shows a new kernel id here even if this
    // process still holds the old socket (review round 3, LOW 2 and 3).
    const live = (await protocol.sessions(target, signal)).find((entry) => entry.name === name)
    const budget = startBudget ? probeKernelStartSeconds : probeTimeoutSeconds
    let stdout = ""
    const answer = await withDeadline(budget, signal, "credential probe", async (inner) => {
      const begin = now()
      for await (const message of opened.execute(probeSnippet(), { allowStdin: false, silent: true, storeHistory: false }, inner)) {
        if (message.msgType === "stream" && message.content.name === "stdout" && typeof message.content.text === "string") stdout += message.content.text
        if (message.msgType === "error") throw new ColabError("RUNTIME_UNVERIFIED", "The credential probe raised inside the kernel.")
      }
      return { rttMs: now() - begin }
    })
    return { output: parseProbeOutput(stdout), kernelId: live?.kernelId ?? opened.session.kernelId, rttMs: answer.rttMs, startMs: now() - started }
  }

  /** The REST cross-check: the same paths where hidden paths are visible, and `content/drive` always. */
  async function restFindings(target: RuntimeTarget, calibration: Calibration, signal: AbortSignal): Promise<{ readonly files: readonly string[]; readonly mounts: boolean }> {
    const files: string[] = []
    if (calibration.hiddenPathsVisible) {
      for (const [folder, names] of Object.entries(CREDENTIAL_FOLDERS)) {
        // `undefined` is "this folder is not there"; a folder REST cannot read at all is not a finding but not a pass
        // either — calibration already recorded whether this runtime's REST checks are blind.
        const entries = await protocol.files.list(target, folder, signal)
        for (const entry of entries ?? []) {
          const base = entry.path.split("/").at(-1) ?? ""
          if (names.includes(base)) files.push(`${folder}/${base}`)
        }
      }
    }
    const drive = await protocol.files.list(target, DRIVE_MOUNT_PATH, signal)
    return { files, mounts: drive !== undefined }
  }

  const taint = (target: RuntimeTarget, code: Extract<ProbeVerdict, { ok: false }>["code"]) => env.ledger.taint(target.runtimeId, { code, at: new Date(now()).toISOString() })

  const codeOf = (error: unknown): Extract<ProbeVerdict, { ok: false }>["code"] =>
    error instanceof ColabError && (error.code === "RUNTIME_HAS_CREDENTIALS" || error.code === "RUNTIME_SHARED") ? error.code : "RUNTIME_UNVERIFIED"

  /** Sessions without the nonce, and connections beyond the baseline plus the plugin's own sockets. */
  async function clientFindings(target: RuntimeTarget, nonce: string, baselineConnections: Readonly<Record<string, number>>, signal: AbortSignal) {
    const sessions = await protocol.sessions(target, signal)
    const attached = new Set(protocol.attachedKernels(target.runtimeId))
    const kernels = await protocol.kernels(target, signal)
    // A kernel created after calibration has no entry; the proxy's own connection is the same for every kernel (L2), so
    // the largest calibrated figure is what it contributes.
    const fallback = Math.max(0, ...Object.values(baselineConnections))
    return {
      foreignSessions: sessions.filter((session) => !session.name.startsWith(`oc-${nonce}-`)).length,
      extraConnections: kernels.filter((kernel) => kernel.connections > (baselineConnections[kernel.id] ?? fallback) + (attached.has(kernel.id) ? 1 : 0)).length,
    }
  }

  /** The one place a finding becomes a code: credentials first, then another client. */
  function verdictOf(findings: ProbeFindings): ProbeVerdict {
    const at = new Date(now()).toISOString()
    if (findings.mounts || findings.credentialFiles.length > 0 || findings.ephemeralMarkers.length > 0) return { ok: false, code: "RUNTIME_HAS_CREDENTIALS", findings, at }
    if (findings.foreignSessions > 0 || findings.extraConnections > 0) return { ok: false, code: "RUNTIME_SHARED", findings, at }
    return { ok: true, findings, at }
  }

  const remember = async (target: RuntimeTarget, verdict: ProbeVerdict) => {
    cache.set(target.runtimeId, { at: now(), verdict })
    if (!verdict.ok) await taint(target, verdict.code)
    return verdict
  }

  return {
    async calibrate(target, nonce, signal) {
      try {
        const hiddenPathsVisible = (await protocol.files.list(target, HIDDEN_PATHS_PROBE, signal)) !== undefined
        const first = await kernelProbe(target, nonce, signal, true)
        // The baseline is the proxy's own connections, measured with the plugin's socket attached and its one socket
        // taken back out, so a proxy that holds a connection (L2) never reads as another client.
        const attachedNow = new Set(protocol.attachedKernels(target.runtimeId))
        const baselineConnections: Record<string, number> = {}
        for (const kernel of await protocol.kernels(target, signal)) baselineConnections[kernel.id] = Math.max(0, kernel.connections - (attachedNow.has(kernel.id) ? 1 : 0))
        const clients = await clientFindings(target, nonce, baselineConnections, signal)
        const verdict = verdictOf({
          mounts: first.output.mounts,
          credentialFiles: first.output.credentialFiles,
          ephemeralMarkers: first.output.ephemeralMarkers,
          foreignSessions: clients.foreignSessions,
          extraConnections: clients.extraConnections,
        })
        if (!verdict.ok) {
          await taint(target, verdict.code)
          throw new ColabError(verdict.code, "The runtime was not clean at its first check, so the plugin tainted it before any code ran.", {
            next: "Plan a freshly created runtime; release this one by plan.",
          })
        }
        return {
          hiddenPathsVisible,
          baselineConnections,
          probeKernel: {
            id: first.kernelId,
            executionCount: first.output.executionCount,
            startMs: first.startMs,
            rttMs: first.rttMs,
            ...(first.output.ramBytes !== undefined ? { ramBytes: first.output.ramBytes } : {}),
          },
          snippetVersion: PROBE_SNIPPET_VERSION,
          at: new Date(now()).toISOString(),
        } satisfies Calibration
      } catch (error) {
        if (error instanceof ColabError && (error.code === "RUNTIME_HAS_CREDENTIALS" || error.code === "RUNTIME_SHARED" || error.code === "RUNTIME_UNVERIFIED")) throw error
        await taint(target, codeOf(error))
        throw error instanceof ColabError ? error : new ColabError(codeOf(error))
      }
    },

    async probe(target, input, signal) {
      const cached = cache.get(target.runtimeId)
      if (!input.fresh && cached && now() - cached.at < cacheMs) return cached.verdict
      try {
        const kernel = await kernelProbe(target, input.nonce, signal, false)
        const at = new Date(now()).toISOString()
        // The probe kernel is started at calibration and never restarted (review round 3, LOW 2 and 3).
        if (kernel.kernelId !== input.calibration.probeKernel.id || kernel.output.executionCount < input.calibration.probeKernel.executionCount) {
          return await remember(target, { ok: false, code: "RUNTIME_UNVERIFIED", findings: emptyFindings(), at })
        }
        const rest = await restFindings(target, input.calibration, signal)
        const clients = await clientFindings(target, input.nonce, input.calibration.baselineConnections, signal)
        return await remember(
          target,
          verdictOf({
            mounts: kernel.output.mounts || rest.mounts,
            credentialFiles: [...new Set([...kernel.output.credentialFiles, ...rest.files])],
            ephemeralMarkers: [...new Set(kernel.output.ephemeralMarkers)],
            foreignSessions: clients.foreignSessions,
            extraConnections: clients.extraConnections,
          }),
        )
      } catch (error) {
        if (error instanceof ColabError && error.code === "CANCELLED") throw error
        return await remember(target, { ok: false, code: codeOf(error), findings: emptyFindings(), at: new Date(now()).toISOString() })
      }
    },
  }
}

const emptyFindings = (): ProbeFindings => ({ mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 })
