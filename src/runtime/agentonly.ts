/**
 * The agent-only check (design §7.4; package B owns it; review round 4 rewrote its evidence model).
 *
 * **Calibration**, on the fresh runtime before any agent code: whether REST can see hidden paths, every kernel's
 * connection count as a baseline, and one clean baseline round trip from the probe kernel — the snapshot the kernel
 * keeps (mounts, credential files, gcloud's config listing and digest, the epoch), its id and execution count, how long
 * it took and its memory. The probe kernel is started here and is never restarted.
 *
 * **The probe**, before and after each run (cached 30 s; `fresh` skips the cache): the kernel compares its current
 * snapshot with the one it kept and answers only changes — a mount that appeared, a credential file that appeared, a
 * gcloud config that moved, a Drive mount wherever it is — plus the epoch, which a restarted kernel no longer has. REST
 * cross-checks the credential files where calibration found hidden paths visible and `content/drive` always; sessions
 * without the nonce and connections beyond the baseline are the other-client check.
 *
 * **What taints, and what does not** (review M2). Findings taint, for good: an observed credential, an observed other
 * client, a probe kernel that restarted. A transport failure — a 503, a dropped socket, a 5 s timeout, a rate limit —
 * refuses with RUNTIME_UNVERIFIED and **does not taint**, because RUNTIME_UNVERIFIED's own next step is "retry". A
 * second OpenCode process is not a finding either: the owner lease refuses it with RUNTIME_BUSY (review M5).
 *
 * This is best effort by construction: the check shares the runtime with the agent's code, which keeps its own
 * environment and may act between probes. An ephemeral credential grant that leaves no trace in the runtime's
 * filesystem, mounts or gcloud config is **not observable** here (review H1); the guarantee's wording lives in
 * docs/v1-design.md, and this module claims nothing beyond observation.
 */
import { createHash } from "node:crypto"
import { ColabError } from "../domain/errors.js"
import type { PortEnv } from "../deps.js"
import type { AgentOnlyCheck, Calibration, KernelSession, ProbeFindings, ProbeVerdict, RuntimeTarget } from "../ports.js"
import { CREDENTIAL_FILES, DRIVE_MOUNT_PATH, GCLOUD_CONFIG_DIR, GCLOUD_CONFIG_MARKER, HIDDEN_PATHS_PROBE } from "./discovery.js"
import { createOwnerLease, type OwnerLease } from "./lease.js"
import { parseBaselineOutput, parseComparisonOutput, probeSnippet, PROBE_SNIPPET_VERSION, ProbeOutputError, type ProbeBaseline, type ProbeComparison } from "./probe.js"
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
  /** The owner lease; the port factory passes the shared one. */
  readonly lease?: OwnerLease
}

/** The epoch a kernel stores at calibration and must answer at every probe; derived, so a later process can check it. */
export const epochFor = (runtimeId: string, nonce: string) => createHash("sha256").update(`${runtimeId}|${nonce}|${PROBE_SNIPPET_VERSION}`).digest("hex").slice(0, 32)

interface KernelAnswer<T> {
  readonly answer: T
  readonly kernelId: string
  readonly rttMs: number
  readonly startMs: number
}

export function createAgentOnlyCheck(env: PortEnv, protocol: RuntimeProtocolInternal, overrides: Partial<AgentOnlyCheckOptions> = {}): AgentOnlyCheck {
  const probeTimeoutSeconds = overrides.probeTimeoutSeconds ?? env.options.probeTimeoutSeconds
  const probeKernelStartSeconds = overrides.probeKernelStartSeconds ?? env.options.probeKernelStartSeconds
  const cacheMs = overrides.cacheMs ?? CACHE_MS
  const lease = overrides.lease ?? createOwnerLease()
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

  /** The probe kernel's session: opened once, reused after, never the agent's. */
  async function probeSession(target: RuntimeTarget, nonce: string, signal: AbortSignal): Promise<KernelSession> {
    const cached = probeSessions.get(target.runtimeId)
    if (cached) return cached
    const opened = await protocol.openSession(target, { name: `oc-${nonce}-${PROBE_SESSION}`, path: PROBE_PATH }, signal)
    if (!opened.session.name.startsWith(`oc-${nonce}-`)) throw new ColabError("RUNTIME_SHARED", "The probe's kernel session was not the plugin's own.")
    probeSessions.set(target.runtimeId, opened)
    return opened
  }

  /** Sends one snippet and returns its stdout, the live kernel id, and how long it took. */
  async function kernelRun<T>(target: RuntimeTarget, nonce: string, signal: AbortSignal, startBudget: boolean, request: { mode: "baseline" | "compare"; epoch: string }, parse: (stdout: string) => T): Promise<KernelAnswer<T>> {
    const name = `oc-${nonce}-${PROBE_SESSION}`
    const started = now()
    const opened = await probeSession(target, nonce, signal)
    // The live session list, not the handle: a kernel that died and was replaced shows a new kernel id here even if this
    // process still holds the old socket.
    const live = (await protocol.sessions(target, signal)).find((entry) => entry.name === name)
    const budget = startBudget ? probeKernelStartSeconds : probeTimeoutSeconds
    let stdout = ""
    const answer = await withDeadline(budget, signal, "credential probe", async (inner) => {
      const begin = now()
      for await (const message of opened.execute(probeSnippet(request), { allowStdin: false, silent: true, storeHistory: false }, inner)) {
        if (message.msgType === "stream" && message.content.name === "stdout" && typeof message.content.text === "string") stdout += message.content.text
        if (message.msgType === "error") throw new ColabError("RUNTIME_UNVERIFIED", "The credential probe raised inside the kernel.")
      }
      return { rttMs: now() - begin }
    })
    return { answer: parse(stdout), kernelId: live?.kernelId ?? opened.session.kernelId, rttMs: answer.rttMs, startMs: now() - started }
  }

  /** The REST cross-check: the same paths where hidden paths are visible, and `content/drive` always. */
  async function restFindings(target: RuntimeTarget, calibration: Calibration, signal: AbortSignal): Promise<{ readonly files: readonly string[]; readonly mounts: boolean }> {
    const files: string[] = []
    if (calibration.hiddenPathsVisible) {
      for (const [folder, names] of Object.entries(CREDENTIAL_FOLDERS)) {
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

  /** Sessions without the nonce, and connections beyond the baseline plus the plugin's own sockets. */
  async function clientFindings(target: RuntimeTarget, nonce: string, baselineConnections: Readonly<Record<string, number>>, signal: AbortSignal) {
    const sessions = await protocol.sessions(target, signal)
    const attached = new Set(protocol.attachedKernels(target.runtimeId))
    const kernels = await protocol.kernels(target, signal)
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

  const taint = (target: RuntimeTarget, code: Extract<ProbeVerdict, { ok: false }>["code"]) => env.ledger.taint(target.runtimeId, { code, at: new Date(now()).toISOString() })

  const remember = async (target: RuntimeTarget, verdict: ProbeVerdict) => {
    cache.set(target.runtimeId, { at: now(), verdict })
    if (!verdict.ok) await taint(target, verdict.code)
    return verdict
  }

  /** A claim the check needs before it may probe; another process's lease is RUNTIME_BUSY, never a taint. */
  async function claimOwner(target: RuntimeTarget) {
    const claim = await lease.claim(target.runtimeId)
    if (claim.owner) return
    throw new ColabError("RUNTIME_BUSY", "Another OpenCode process is using this runtime.", {
      next: "Use that session, or stop its run there; the runtime is not tainted.",
    })
  }

  return {
    async calibrate(target, nonce, signal) {
      await claimOwner(target)
      const hiddenPathsVisible = (await protocol.files.list(target, HIDDEN_PATHS_PROBE, signal)) !== undefined
      const epoch = epochFor(target.runtimeId, nonce)
      const first = await kernelRun(target, nonce, signal, true, { mode: "baseline", epoch }, parseBaselineOutput)
      // The baseline is the proxy's own connections, measured with the plugin's socket attached and its one socket
      // taken back out, so a proxy that holds a connection (L2) never reads as another client.
      const attachedNow = new Set(protocol.attachedKernels(target.runtimeId))
      const baselineConnections: Record<string, number> = {}
      for (const kernel of await protocol.kernels(target, signal)) baselineConnections[kernel.id] = Math.max(0, kernel.connections - (attachedNow.has(kernel.id) ? 1 : 0))
      const clients = await clientFindings(target, nonce, baselineConnections, signal)
      const verdict = verdictOf({
        mounts: first.answer.driveMount,
        credentialFiles: first.answer.credentialFiles,
        ephemeralMarkers: [],
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
          executionCount: first.answer.executionCount,
          startMs: first.startMs,
          rttMs: first.rttMs,
          ...(first.answer.ramBytes !== undefined ? { ramBytes: first.answer.ramBytes } : {}),
        },
        snippetVersion: PROBE_SNIPPET_VERSION,
        at: new Date(now()).toISOString(),
      } satisfies Calibration
    },

    async probe(target, input, signal) {
      const cached = cache.get(target.runtimeId)
      if (!input.fresh && cached && now() - cached.at < cacheMs) return cached.verdict
      // A transient failure refuses and is not cached; only findings and a restarted probe kernel taint (review M2).
      try {
        await claimOwner(target)
        const epoch = epochFor(target.runtimeId, input.nonce)
        const kernel = await kernelRun(target, input.nonce, signal, false, { mode: "compare", epoch }, parseComparisonOutput)
        const at = new Date(now()).toISOString()
        const restarted = kernel.answer.restarted || !kernel.answer.epochOk || kernel.answer.epoch !== epoch || kernel.kernelId !== input.calibration.probeKernel.id
        if (restarted) return await remember(target, { ok: false, code: "RUNTIME_UNVERIFIED", findings: emptyFindings(), at })
        const rest = await restFindings(target, input.calibration, signal)
        const clients = await clientFindings(target, input.nonce, input.calibration.baselineConnections, signal)
        return await remember(
          target,
          verdictOf({
            mounts: kernel.answer.driveMount || kernel.answer.mountsChanged || rest.mounts,
            credentialFiles: [...new Set([...kernel.answer.addedFiles, ...rest.files])],
            ephemeralMarkers: kernel.answer.configChanged ? [GCLOUD_CONFIG_MARKER] : [],
            foreignSessions: clients.foreignSessions,
            extraConnections: clients.extraConnections,
          }),
        )
      } catch (error) {
        if (error instanceof ColabError && (error.code === "CANCELLED" || error.code === "RUNTIME_BUSY")) throw error
        // A probe answer that does not parse is an integrity break and taints; an outage, a timeout or a rate limit
        // refuses and leaves the runtime usable (review M2).
        if (error instanceof ProbeOutputError) return await remember(target, { ok: false, code: "RUNTIME_UNVERIFIED", findings: emptyFindings(), at: new Date(now()).toISOString() })
        const code = error instanceof ColabError && (error.code === "RUNTIME_HAS_CREDENTIALS" || error.code === "RUNTIME_SHARED") ? error.code : "RUNTIME_UNVERIFIED"
        return { ok: false, code, findings: emptyFindings(), at: new Date(now()).toISOString() }
      }
    },
  }
}

const emptyFindings = (): ProbeFindings => ({ mounts: false, credentialFiles: [], ephemeralMarkers: [], foreignSessions: 0, extraConnections: 0 })

/** The gcloud config directory the probe baselines, for a caller that wants to name it (tests, status). */
export const PROBE_CONFIG_DIR = GCLOUD_CONFIG_DIR

export type { ProbeBaseline, ProbeComparison }
