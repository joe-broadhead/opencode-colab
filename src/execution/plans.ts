/**
 * Package D's two consumer plans (design §7.2): `runtime.create` (write) and `runtime.delete` (delete).
 *
 * A create's preview carries what the person must see before compute starts: the spec and whether the tier can use it,
 * the accelerator allow-list verdict, the runtimes of ours already running (and the one to reuse instead), the lease
 * (idle release after `autoReleaseMinutes`, and `maxRuntimeHours`), the `keep` paths, and the sentence that files
 * outside `keep` and every variable in memory are lost at release. The commit re-reads eligibility and the count and
 * answers PLAN_CHANGED if either moved; it creates with a caller-chosen `oc-` id and a UUID4 `requestId`, so a retry
 * joins the first create, then calibrates the fresh runtime before any agent code (design §7.4).
 *
 * A delete's preview carries the age, Jupyter's idle state, the files on `/content` outside `keep`, and that memory is
 * lost; a run active on the runtime is RUNTIME_BUSY unless `force`. The commit re-reads the same facts and calls
 * package F's one release function through the `Release` port — never a second delete path of its own.
 */
import { OPERATIONS } from "../domain/actions.js"
import { ColabError, type WarningCode } from "../domain/errors.js"
import type { RuntimeRecord, RuntimeSpecKey, StoredPlan } from "../ports.js"
import type { HandlerContext, PlanHandler, PlanParams, PlanPreview } from "../tools/types.js"
import { oursRunning, specLabel } from "./views.js"
import { runsOn } from "./runs.js"
import { bareRuntimeId, kept , nonce, requestId, runtimeId } from "./support.js"

/** The LRO wait a create's commit may use (design §9.1's `B`, 4 minutes until the host measurement lands). */
const CREATE_WAIT_MS = 240_000
const SOLO_LOSS = "Files outside keep and all variables in memory are lost when this runtime is released; save results to /content/outputs."

const keyOf = (spec: RuntimeSpecKey) => `${spec.variant}|${spec.shape}|${spec.accelerator}`
const allowed = (spec: RuntimeSpecKey, ctx: HandlerContext) => ctx.deps.options.accelerators.some((entry) => entry.toUpperCase() === spec.accelerator.toUpperCase())

const planChanged = (detail: string): never => {
  throw new ColabError("PLAN_CHANGED", detail, { next: "Plan again and show the person the new preview." })
}

const ageHours = (createdAt: string, now: string) => Math.max(0, Math.round(((Date.parse(now) - Date.parse(createdAt)) / 3_600_000) * 10) / 10)

interface CreatePayload {
  readonly spec: RuntimeSpecKey
  readonly keep: readonly string[]
  readonly runtimeId: string
  readonly requestId: string
  readonly nonce: string
}

/** The facts a create's preview and commit both read: eligibility, tier, the allow-list, and the runtimes of ours. */
async function createFacts(spec: RuntimeSpecKey, ctx: HandlerContext, read: boolean): Promise<{ readonly eligible: boolean; readonly tier: string; readonly ours: readonly RuntimeRecord[]; readonly verdict: string }> {
  if (read) await ctx.providerRead(OPERATIONS.runtimeSpecsList)
  if (read) await ctx.providerRead(OPERATIONS.subscriptionGet)
  const [specs, tier, ours] = await Promise.all([
    ctx.deps.colab.listRuntimeSpecs(ctx.account.alias, ctx.call.signal),
    ctx.deps.colab.getSubscription(ctx.account.alias, ctx.call.signal),
    oursRunning(ctx.account.alias, ctx.deps.ledger),
  ])
  const found = specs.find((entry) => keyOf(entry.key) === keyOf(spec))
  return { eligible: found?.eligible === true, tier, ours, verdict: found === undefined ? "the account's spec list does not offer this spec" : found.eligible ? "eligible for this tier" : "not eligible for this tier" }
}

/** The budget check at both steps (design §8.5): `refuse` stops the plan, `warn` becomes BUDGET_WARN. */
async function budgetVerdict(ctx: HandlerContext, spec: RuntimeSpecKey): Promise<{ readonly verdict: "ok" | "warn" | "refuse"; readonly warnings: WarningCode[] }> {
  const answer = await ctx.deps.budget.check(ctx.account.alias, { action: "runtime.create", runtimeHours: ctx.deps.options.maxRuntimeHours }, ctx.call.signal)
  if (answer.verdict === "refuse") throw new ColabError("BUDGET_REACHED", "The account's runtime-hours budget is spent, so this plan makes no runtime.", { next: "Wait for the daily reset, or raise the account's budget." })
  return { verdict: answer.verdict, warnings: answer.verdict === "warn" ? ["BUDGET_WARN"] : [] }
}

const CREATE: PlanHandler<"runtime.create"> = {
  async preview(params: PlanParams<"runtime.create">, ctx): Promise<PlanPreview> {
    const spec = params.spec
    const keeps = params.keep ?? ctx.deps.options.keep
    if (!allowed(spec, ctx)) throw new ColabError("ACCELERATOR_NOT_ALLOWED", `${spec.accelerator} is not in the plugin's accelerators (${ctx.deps.options.accelerators.join(", ")}).`, { next: "Pick an allowed spec; the person may add the accelerator." })
    const facts = await createFacts(spec, ctx, true)
    if (!facts.eligible) throw new ColabError("SPEC_NOT_ELIGIBLE", facts.verdict)
    const budget = await budgetVerdict(ctx, spec)
    const running = facts.ours.filter((record) => record.state === "ready")
    if (running.length >= ctx.deps.options.maxRuntimes) {
      throw new ColabError("RUNTIME_CAP", `The plugin already runs ${running.length} runtime(s) of its own, its maxRuntimes.`, { next: `Reuse ${running[0]!.id}, or release one by plan.` })
    }
    const warnings: WarningCode[] = [...budget.warnings]
    if (facts.tier === "SUBSCRIPTION_TIER_FREE") warnings.push("FREE_TIER_PRIORITY")
    return {
      preview: {
        spec: specLabel(spec),
        accelerator: spec.accelerator,
        eligible: facts.eligible,
        tier: facts.tier,
        verdict: facts.verdict,
        accelerators: [...ctx.deps.options.accelerators],
        runtimesOurs: running.map((record) => record.id),
        maxRuntimes: ctx.deps.options.maxRuntimes,
        reuse: running[0]?.id ?? null,
        lease: { releaseAfterIdleMinutes: ctx.deps.options.autoReleaseMinutes, maxHours: ctx.deps.options.maxRuntimeHours },
        keep: [...keeps],
        release: SOLO_LOSS,
        budget: budget.verdict,
      },
      payload: { spec, keep: [...keeps], runtimeId: runtimeId(), requestId: requestId(), nonce: nonce() } satisfies CreatePayload,
      fingerprint: {
        spec: keyOf(spec),
        eligible: facts.eligible,
        allowed: true,
        tier: facts.tier,
        ours: running.map((record) => record.id).sort().join(","),
        maxRuntimes: ctx.deps.options.maxRuntimes,
        budget: budget.verdict,
      },
      warnings,
    }
  },

  async commit(plan: StoredPlan, ctx) {
    const payload = plan.payload as unknown as CreatePayload
    if (!payload.spec || !payload.runtimeId || !payload.requestId || !payload.nonce || !Array.isArray(payload.keep)) {
      planChanged("The plan holds no create payload, so there is nothing to create.")
    }
    const facts = await createFacts(payload.spec, ctx, false)
    const running = facts.ours.filter((record) => record.state === "ready")
    const budget = await budgetVerdict(ctx, payload.spec)
    if (!facts.eligible || facts.tier !== plan.fingerprint.tier || running.map((record) => record.id).sort().join(",") !== plan.fingerprint.ours || budget.verdict !== plan.fingerprint.budget) {
      planChanged("The spec's eligibility, the tier, the runtimes of ours, or the budget check differs from the preview.")
    }
    if (running.length >= ctx.deps.options.maxRuntimes) throw new ColabError("RUNTIME_CAP", `The plugin already runs ${running.length} runtime(s) of its own, its maxRuntimes.`, { next: `Reuse ${running[0]!.id}, or release one by plan.` })
    const answer = await ctx.deps.colab.createRuntime(ctx.account.alias, { runtimeId: payload.runtimeId, spec: payload.spec, requestId: payload.requestId, waitMs: CREATE_WAIT_MS }, ctx.call.signal)
    const id = bareRuntimeId(answer.runtime?.name ?? payload.runtimeId)
    const base: RuntimeRecord = {
      id,
      account: ctx.account.alias,
      backend: "colab",
      spec: payload.spec,
      createdAt: ctx.deps.clock.now().toISOString(),
      nonce: payload.nonce,
      keep: [...payload.keep],
      lease: { releaseAfterIdleMinutes: ctx.deps.options.autoReleaseMinutes, maxHours: ctx.deps.options.maxRuntimeHours },
      state: answer.done ? "ready" : "creating",
    }
    if (!answer.done) {
      await ctx.deps.ledger.putRuntime(base)
      return { runtime: id, state: "creating", operation: answer.operation, spec: specLabel(payload.spec), lease: base.lease, keep: base.keep, release: SOLO_LOSS }
    }
    // Calibration runs on the fresh runtime before any agent code (design §7.4 step 2); a finding taints it at birth.
    try {
      const calibration = await ctx.deps.check.calibrate({ account: ctx.account.alias, runtimeId: id }, payload.nonce, ctx.call.signal)
      const record: RuntimeRecord = { ...base, calibration }
      await ctx.deps.ledger.putRuntime(record)
      return {
        runtime: id,
        state: "ready",
        spec: specLabel(payload.spec),
        lease: record.lease,
        keep: record.keep,
        calibration: { hiddenPathsVisible: calibration.hiddenPathsVisible, probeKernel: calibration.probeKernel },
        release: SOLO_LOSS,
      }
    } catch (error) {
      const code = ColabError.is(error) && (error.code === "RUNTIME_HAS_CREDENTIALS" || error.code === "RUNTIME_SHARED") ? error.code : undefined
      await ctx.deps.ledger.putRuntime({ ...base, ...(code ? { tainted: { code, at: ctx.deps.clock.now().toISOString() } } : {}) })
      if (code) {
        return {
          runtime: id,
          state: "tainted",
          error: code,
          message: "The runtime was tainted by its first check, before any code ran, so it will not run code.",
          next: `Release it by plan (runtime.delete), then plan a fresh runtime.create.`,
        }
      }
      return {
        runtime: id,
        state: "unverified",
        error: ColabError.is(error) ? error.code : "RUNTIME_UNVERIFIED",
        message: "The runtime was created but its first check did not complete, so it has no calibration and will not run code.",
        next: "Release it by plan (runtime.delete) and plan a fresh runtime.create.",
      }
    }
  },
}

/** The delete plan's own facts, read by the preview and re-read by the commit. */
interface DeleteFacts {
  readonly record: RuntimeRecord
  /** True when Jupyter can be read: ready, untainted, calibrated. A tainted, unchecked or creating runtime is never read. */
  readonly harvestable: boolean
  readonly notHarvested?: "tainted" | "unchecked" | "creating"
  /** Whether the Colab API still returns the runtime; `undefined` when the answer could not be read. */
  readonly exists?: boolean
  readonly kernels: number
  readonly busy: boolean
  readonly idleSince?: string
  readonly lost: readonly string[]
  readonly active: number
}

/**
 * The facts a release plan reads. A runtime this plugin cannot use — tainted, never calibrated, or a create whose LRO
 * has not finished — is still releasable: its plan reads only the ledger and the Colab API, never Jupyter, because the
 * transport refuses those runtimes and every one of them keeps billing until it is deleted (review M3).
 */
async function deleteFacts(id: string, ctx: HandlerContext, read: boolean): Promise<DeleteFacts> {
  const record = await ctx.deps.ledger.getRuntime(id)
  if (!record || record.account !== ctx.account.alias) throw new ColabError("RUNTIME_NOT_OURS")
  if (record.state === "released" || record.state === "gone") throw new ColabError("RUNTIME_GONE")
  const notHarvested: DeleteFacts["notHarvested"] = record.tainted ? "tainted" : record.state === "creating" ? "creating" : record.calibration ? undefined : "unchecked"
  const harvestable = notHarvested === undefined && record.state === "ready"
  // The API read is the one fact both paths need: is the runtime still there to delete?
  if (read) await ctx.providerRead(OPERATIONS.runtimesGet)
  const exists = await ctx.deps.colab
    .getRuntime(record.account, record.id, ctx.call.signal)
    .then((answer) => answer !== undefined)
    .catch(() => undefined)
  if (!harvestable) return { record, harvestable, ...(notHarvested ? { notHarvested } : {}), ...(exists !== undefined ? { exists } : {}), kernels: 0, busy: false, lost: [], active: runsOn(record.id) }
  if (read) await ctx.providerRead(OPERATIONS.kernelsList)
  if (read) await ctx.providerRead(OPERATIONS.sessionsList)
  if (read) await ctx.providerRead(OPERATIONS.contentsList)
  const target = { account: record.account, runtimeId: record.id }
  const [kernels, sessions, entries] = await Promise.all([
    ctx.deps.runtime.kernels(target, ctx.call.signal),
    ctx.deps.runtime.sessions(target, ctx.call.signal),
    ctx.deps.runtime.files.list(target, "/content", ctx.call.signal),
  ])
  const busy = kernels.some((kernel) => kernel.executionState !== "idle")
  const since = kernels
    .map((kernel) => kernel.lastActivity)
    .filter(Boolean)
    .sort()
    .at(-1)
  const lost = (entries ?? [])
    .filter((entry) => entry.type !== "directory")
    .map((entry) => entry.path)
    .filter((path) => !kept(path, record.keep))
    .sort()
    .slice(0, 100)
  return { record, harvestable, ...(exists !== undefined ? { exists } : {}), kernels: kernels.length, busy, ...(since ? { idleSince: since } : {}), lost, active: runsOn(record.id) }
}

const why = (reason: NonNullable<DeleteFacts["notHarvested"]>) =>
  reason === "tainted"
    ? "the runtime is tainted, so the plugin will not read it"
    : reason === "creating"
      ? "the runtime's create has not finished, so nothing has been checked"
      : "the runtime was never checked (its calibration did not complete)"

const DELETE: PlanHandler<"runtime.delete"> = {
  async preview(params: PlanParams<"runtime.delete">, ctx): Promise<PlanPreview> {
    const facts = await deleteFacts(params.runtime, ctx, true)
    if (facts.active > 0 && params.force !== true) {
      throw new ColabError("RUNTIME_BUSY", "A run is active on this runtime in this process.", { next: "Stop it with colab_cancel, or plan again with force." })
    }
    return {
      preview: {
        runtime: facts.record.id,
        account: facts.record.account,
        spec: specLabel(facts.record.spec),
        ageHours: ageHours(facts.record.createdAt, ctx.deps.clock.now().toISOString()),
        state: facts.record.state,
        tainted: facts.record.tainted?.code ?? null,
        calibrated: Boolean(facts.record.calibration),
        harvest: facts.harvestable,
        ...(facts.notHarvested ? { notHarvested: why(facts.notHarvested) } : {}),
        ...(facts.exists !== undefined ? { exists: facts.exists } : {}),
        idle: facts.harvestable ? !facts.busy : null,
        ...(facts.idleSince ? { idleSince: facts.idleSince } : {}),
        kernels: facts.kernels,
        activeRun: facts.active > 0,
        force: params.force === true,
        keep: [...facts.record.keep],
        filesOutsideKeep: [...facts.lost],
        filesLost: facts.harvestable ? [...facts.lost] : "everything on the runtime",
        memory: "Variables in memory are lost.",
        release: facts.harvestable
          ? "The release harvests the keep paths, then deletes the runtime; files outside keep are lost. Nothing else on the runtime is kept."
          : `Not harvested: ${why(facts.notHarvested!)}. The release deletes it through the Colab API, and everything on it is lost.`,
      },
      payload: { runtime: facts.record.id, force: params.force === true },
      fingerprint: {
        state: facts.record.state,
        tainted: facts.record.tainted?.at ?? "",
        harvestable: facts.harvestable,
        exists: facts.exists === true,
        busy: facts.busy,
        active: facts.active > 0,
        lost: facts.lost.join("\n"),
      },
    }
  },

  async commit(plan: StoredPlan, ctx) {
    const payload = plan.payload as unknown as { runtime: string; force: boolean }
    if ((payload.runtime as string | undefined) === undefined) planChanged("The plan holds no runtime, so there is nothing to release.")
    const facts = await deleteFacts(payload.runtime, ctx, false)
    if (
      facts.record.state !== plan.fingerprint.state ||
      (facts.record.tainted?.at ?? "") !== plan.fingerprint.tainted ||
      facts.harvestable !== plan.fingerprint.harvestable ||
      (facts.exists === true) !== plan.fingerprint.exists ||
      facts.busy !== plan.fingerprint.busy ||
      facts.active > 0 !== plan.fingerprint.active ||
      facts.lost.join("\n") !== plan.fingerprint.lost
    ) {
      planChanged("The runtime's state, taint, existence, idle state, active run or the files outside keep differ from the preview.")
    }
    if (facts.active > 0 && !payload.force) throw new ColabError("RUNTIME_BUSY", "A run is active on this runtime.", { next: "Stop it with colab_cancel, or plan again with force." })
    // Package F's one release function: it harvests when the runtime is readable, and deletes it either way.
    const released = await ctx.deps.release.release(facts.record, { reason: "plan", force: payload.force }, ctx.call.signal)
    return {
      runtime: facts.record.id,
      state: released.released ? "released" : "kept",
      harvest: facts.harvestable,
      ...(facts.notHarvested ? { notHarvested: why(facts.notHarvested) } : {}),
      harvested: [...released.harvested],
      warnings: [...released.warnings],
    }
  },
}

export const PLAN_HANDLERS = { "runtime.create": { colab: CREATE }, "runtime.delete": { colab: DELETE } }
