/**
 * The one release function (design §8.3 step 2, §16 package F): harvest the `keep` paths, then `runtimes.delete`.
 * Both the automation and the `runtime.delete` plan go through it, so there is one code path that can end a consumer
 * runtime, and it harvests first.
 *
 * What it never does:
 *
 * - never releases a runtime that is not the plugin's own, or one already released or gone (it is idempotent);
 * - never releases one another OpenCode process holds: the lease package B writes (`<ledger>/owners/<runtime>.json`,
 *   `{ pid, at, sessions }`, stale after two minutes) is read here, and a live foreign pid is left alone by the
 *   automation and refused with `RUNTIME_BUSY` when a person commits a plan;
 * - never releases a runtime with a run of ours active unless the plan says `force`;
 * - never releases a tainted runtime from the automation at all;
 * - never quietly drops `keep` files: a harvest that fails (a read error, a file over `maxDownloadBytes`, an
 *   unreadable tree) blocks the release and answers `UNHARVESTED`, except for the one case where the harvest cannot run
 *   by policy — a tainted runtime, whose transport fence refuses every read, and which the design says a person
 *   releases by plan; then the plan's preview has already said what is lost and the result carries `UNHARVESTED`.
 *
 * The harvest lands in `<workDir>/harvest/<runtimeId>/<path on the runtime>`, so `.colab/harvest/oc-…/content/outputs`
 * holds what `/content/outputs` held. Nothing outside that folder is ever written.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import type { PortEnv } from "../deps.js"
import { ColabError } from "../domain/errors.js"
import type { WarningCode } from "../domain/errors.js"
import type { ColabApi, Clock, ContentEntry, Ledger, Release, RuntimeProtocol, RuntimeRecord, RuntimeTarget } from "../ports.js"
import type { RuntimePorts } from "../runtime/index.js"

/** How far a `/content/outputs/**` walk goes, and how many files it takes: past either, the harvest fails, never skips. */
const MAX_DEPTH = 8
const MAX_ENTRIES = 500
/** The lease package B writes is stale after two minutes without a heartbeat (src/runtime/lease.ts). */
const LEASE_STALE_MS = 120_000

export interface ReleasePorts {
  readonly options: PortEnv["options"]
  readonly directory: string
  readonly clock: Clock
  readonly ledger: Ledger
  readonly colab: Pick<ColabApi, "deleteRuntime" | "getRuntime">
  readonly runtime: Pick<RuntimeProtocol, "files">
}

export interface Harvested {
  readonly ok: boolean
  /** Paths on the runtime that were harvested, in the order they were found. */
  readonly files: readonly string[]
  readonly reason?: string
}

/** A harvest that must stop: past a bound, a refused path, a read or a write. It becomes `UNHARVESTED`. */
class HarvestStop extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

const alive = (pid: number): boolean => {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The pid of another live OpenCode process holding this runtime's lease, if any. */
export function foreignLeaseHolder(ledger: object, runtimeId: string, now: () => number = Date.now, pid = process.pid): number | undefined {
  const dir = (ledger as { readonly dir?: string }).dir
  if (typeof dir !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runtimeId)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "owners", `${runtimeId}.json`), "utf8")) as { pid?: unknown; at?: unknown }
    if (typeof parsed.pid !== "number" || typeof parsed.at !== "number") return undefined
    if (parsed.pid === pid) return undefined
    if (!alive(parsed.pid) || now() - parsed.at >= LEASE_STALE_MS) return undefined
    return parsed.pid
  } catch {
    return undefined
  }
}

/** The path a runtime path maps to inside the harvest folder; anything that could leave it is refused. */
function harvestPath(harvestDir: string, runtimePath: string): string | undefined {
  const relative = runtimePath.replace(/^\/+/, "")
  if (relative === "") return undefined
  const segments = relative.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\\"))) return undefined
  const target = resolve(harvestDir, ...segments)
  return target.startsWith(`${resolve(harvestDir)}${sep}`) ? target : undefined
}

/** Downloads every keep path into `<workDir>/harvest/<runtimeId>/`; a failure leaves a partial folder and `ok: false`. */
export async function harvestRuntime(input: {
  readonly files: Pick<RuntimeProtocol, "files">
  readonly target: RuntimeTarget
  readonly keep: readonly string[]
  readonly harvestDir: string
  readonly maxBytes: number
  readonly signal: AbortSignal
}): Promise<Harvested> {
  const collected: ContentEntry[] = []
  try {
    const seen = new Set<string>()
    const visit = async (loop: { readonly path: string; readonly depth: number; readonly all: boolean; readonly out: ContentEntry[]; hits: number }): Promise<void> => {
      if (loop.depth > MAX_DEPTH || ++loop.hits > MAX_ENTRIES * 2) throw new HarvestStop(loop.depth > MAX_DEPTH ? "depth" : "count")
      const entries = await input.files.files.list(input.target, loop.path, input.signal)
      for (const entry of entries ?? []) {
        if (loop.out.length >= MAX_ENTRIES) throw new HarvestStop("count")
        if (entry.type === "directory") {
          if (loop.all) await visit({ ...loop, path: entry.path, depth: loop.depth + 1 })
        } else if (!seen.has(entry.path)) {
          seen.add(entry.path)
          loop.out.push(entry)
        }
      }
    }
    for (const pattern of input.keep) await visit({ path: pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern, depth: 1, all: pattern.endsWith("/**"), out: collected, hits: 0 })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error
    if (error instanceof HarvestStop) return { ok: false, files: [], reason: error.reason }
    return { ok: false, files: [], reason: ColabError.is(error) ? error.code : "read" }
  }

  const done: string[] = []
  for (const entry of collected) {
    const path = harvestPath(input.harvestDir, entry.path)
    if (path === undefined) return { ok: false, files: done, reason: "PATH_REFUSED" }
    const temp = `${path}.tmp-${process.pid}`
    try {
      const chunks: Uint8Array[] = []
      let bytes = 0
      for await (const chunk of await input.files.files.read(input.target, entry.path, input.signal)) {
        bytes += chunk.length
        if (bytes > input.maxBytes) throw new HarvestStop("FILE_TOO_LARGE")
        chunks.push(chunk)
      }
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(temp, Buffer.concat(chunks), { mode: 0o600 })
      renameSync(temp, path)
      done.push(entry.path.startsWith("/") ? entry.path : `/${entry.path}`)
    } catch (error) {
      rmSync(temp, { force: true })
      if (error instanceof Error && error.name === "AbortError") throw error
      if (error instanceof HarvestStop) return { ok: false, files: done, reason: error.reason }
      return { ok: false, files: done, reason: ColabError.is(error) ? error.code : "write" }
    }
  }
  return { ok: true, files: done }
}

/** Closes a ledger record as released or gone, with the event status and the `colab.runs` source read. */
export async function closeRecord(ledger: Pick<Ledger, "putRuntime" | "append">, record: RuntimeRecord, state: "released" | "gone", at: string): Promise<RuntimeRecord> {
  const next: RuntimeRecord = { ...record, state, releasedAt: at }
  await ledger.putRuntime(next)
  await ledger.append({ type: state === "released" ? "runtime.released" : "runtime.gone", id: record.id, account: record.account })
  return next
}

export function createRelease(env: PortEnv, ports: RuntimePorts): Release {
  const ledger = env.ledger
  return {
    async release(runtime, input, signal) {
      const current = (await ledger.getRuntime(runtime.id)) ?? runtime
      if (current.state === "released" || current.state === "gone") return { harvested: [], released: false, warnings: [] }
      if (current.tainted && input.reason !== "plan") return { harvested: [], released: false, warnings: [] }

      const holder = foreignLeaseHolder(ledger, current.id)
      if (holder !== undefined) {
        if (input.reason === "plan") {
          throw new ColabError("RUNTIME_BUSY", "Another OpenCode process is using this runtime.", { next: "Use that session, or stop its run there; nothing was released." })
        }
        return { harvested: [], released: false, warnings: [] }
      }

      const active = (await ledger.listRuns({ account: current.account, state: "running" })).filter((run) => run.runtime === current.id)
      if (active.length > 0 && !input.force) {
        if (input.reason === "plan") throw new ColabError("RUNTIME_BUSY", "A run of the plugin's own is active on this runtime.", { next: "Stop it with colab_cancel, or plan again with force." })
        return { harvested: [], released: false, warnings: [] }
      }

      const target: RuntimeTarget = { account: current.account, runtimeId: current.id }
      let harvested: Harvested = { ok: true, files: [] }
      if (current.tainted) {
        // The transport fence refuses every read on a tainted runtime, so a plan is the only way to release one, and
        // the preview has already said that what was not saved is lost.
        harvested = { ok: false, files: [], reason: "tainted" }
      } else {
        harvested = await harvestRuntime({
          files: ports.runtime,
          target,
          keep: current.keep,
          harvestDir: join(env.directory, env.options.workDir, "harvest", current.id),
          maxBytes: env.options.maxDownloadBytes,
          signal,
        })
        // A harvest that failed blocks the release, the plan's included: the keep files were promised, and the result
        // says UNHARVESTED rather than losing them quietly. The one exception is a tainted runtime, above.
        if (!harvested.ok) return { harvested: harvested.files, released: false, warnings: ["UNHARVESTED"] }
      }

      const warnings: WarningCode[] = harvested.ok ? [] : ["UNHARVESTED"]
      try {
        await ports.colab.deleteRuntime(current.account, current.id, signal)
        await closeRecord(ledger, current, "released", env.clock.now().toISOString())
        return { harvested: harvested.files, released: true, warnings }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error
        if (ColabError.is(error) && error.code === "NOT_FOUND") {
          await closeRecord(ledger, current, "gone", env.clock.now().toISOString())
          return { harvested: harvested.files, released: true, warnings }
        }
        throw error
      }
    },
  }
}

/** What a release loses, one sentence, the same in the plan preview, status and `/colab-cleanup` (design §8.3). */
export const RELEASE_LOSS = "Files outside keep and all variables in memory are lost at release; save to /content/outputs first."
