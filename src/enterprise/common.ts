/**
 * What the Enterprise plans share: choosing compute and its price, the cap and the ceiling, reading a notebook for a
 * `job.create` preview and commit, and the per-run and per-month worst case a schedule shows.
 *
 * The cost rules are design §8.6: the accelerator allow-list covers a machine's included GPU as well as a named one;
 * `maxJobUsd` is the cap, `maxJobUsdCeiling` the ceiling, `rates` overrides this table, and a machine missing from the
 * table answers `ESTIMATE_UNKNOWN` before anything is created. The job's bound is `jobTimeoutMinutes` (default 60): a
 * call may shorten it, not lengthen it, so the option's bound holds with the laptop off (design §8.2).
 */
import { readFileSync } from "node:fs"
import type { HandlerContext } from "../tools/types.js"
import { ColabError, type WarningCode } from "../domain/errors.js"
import { OPERATIONS } from "../domain/actions.js"
import { screenSecrets } from "../redact.js"
import { acceleratorShort, acceleratorType, PRICES_AS_OF, PRICES_REGION, priceGaps, priceOf, type Price } from "./prices.js"
import { enterpriseSettings, type EnterpriseSettings } from "./account.js"
import { parseNotebook, sha256Of, type Notebook, type SecretScreen } from "./notebook.js"
import { nextRuns, occurrencesBetween, parseCron } from "./cron.js"
import { computeOfSchedule, type ComputeSpec } from "./detail.js"
import { sessionLabel } from "./ids.js"
import { projectPath, resolveLocal } from "./paths.js"
import type { EnterpriseSchedule } from "../ports.js"

export const settingsFor = (ctx: HandlerContext, what: string, options: { readonly bucket?: boolean } = {}): EnterpriseSettings => enterpriseSettings(ctx.deps, ctx.account.alias, what, options)

/** A job resource name from an id or a full name. */
export const jobNameOf = (settings: EnterpriseSettings, job: string) => (job.startsWith("projects/") ? job : `${parentOfName(settings)}/notebookExecutionJobs/${job}`)

/** A schedule resource name from an id or a full name. */
export const scheduleNameOf = (settings: EnterpriseSettings, schedule: string) => (schedule.startsWith("projects/") ? schedule : `${parentOfName(settings)}/schedules/${schedule}`)

const parentOfName = (settings: EnterpriseSettings) => `projects/${settings.project}/locations/${settings.region}`

/** The kinds of secret-shaped text in a notebook's cell sources, and how many cells carry one (design §7.5). */
function screenNotebook(notebook: Notebook): SecretScreen {
  const kinds = new Set<string>()
  let found = 0
  for (const cell of notebook.cells) {
    const screen = screenSecrets(cell.source)
    if (!screen.found) continue
    found += 1
    for (const kind of screen.kinds) kinds.add(kind)
  }
  return { found, kinds: [...kinds].sort() }
}

/**
 * The opt-in budget (design §8.5), asked at a plan's preview and again at its commit: `refuse` stops the change with
 * BUDGET_REACHED, `warn` rides back as BUDGET_WARN. Package F owns the answer; Day 0's stub says ok.
 */
export async function budgetCheck(ctx: HandlerContext, action: "job.create" | "schedule.create" | "schedule.resume", usd: number | undefined): Promise<readonly WarningCode[]> {
  const answer = await ctx.deps.budget.check(ctx.account.alias, { action, ...(usd !== undefined ? { usd } : {}) }, ctx.call.signal)
  if (answer.verdict === "refuse") {
    throw new ColabError("BUDGET_REACHED", `The account's budget refuses ${action}${answer.unit === "usd" && answer.limit !== undefined ? ` (limit $${answer.limit.toFixed(2)})` : ""}.`, {
      next: "Wait for the daily reset, or raise the account's budget.",
    })
  }
  return answer.verdict === "warn" ? ["BUDGET_WARN"] : []
}

/** The plan params give a notebook as a union of {path} and {gcs}; one shape the handlers read. */
export function notebookParam(notebook: { readonly path: string } | { readonly gcs: string }): { readonly path?: string; readonly gcs?: string } {
  return "path" in notebook ? { path: notebook.path } : { gcs: notebook.gcs }
}

export interface ComputeChoice {
  readonly machine: string
  readonly accelerator: string | undefined
  readonly acceleratorCount: number
  readonly template: string | undefined
  readonly timeoutMinutes: number
  readonly price: Price
  readonly source: "template" | "customEnvironmentSpec"
  /** The account's region, which decides the endpoint and whether the us-central1 table can price it. */
  readonly region: string
}

export interface ComputeParams {
  readonly template?: string
  readonly machine?: string
  readonly accelerator?: string
  readonly timeoutMinutes?: number
}

const templateMachine = (template: Readonly<Record<string, unknown>>): ComputeSpec => {
  const machineSpec = (template.machineSpec ?? {}) as Record<string, unknown>
  return {
    ...(typeof machineSpec.machineType === "string" ? { machine: machineSpec.machineType } : {}),
    ...(typeof machineSpec.acceleratorType === "string" ? { accelerator: machineSpec.acceleratorType } : {}),
    ...(typeof machineSpec.acceleratorCount === "number" ? { acceleratorCount: machineSpec.acceleratorCount } : {}),
  }
}

const templateName = (template: Readonly<Record<string, unknown>>) => (typeof template.name === "string" ? template.name : "")

/**
 * The compute a job or a schedule runs on: an existing template (read-only, its machine and accelerator), or
 * `customEnvironmentSpec` from `machine` (default `enterpriseMachine`) and an optional accelerator. A named accelerator
 * must fit the machine's family (the price table knows which), and the effective GPU — a named one or the machine's own —
 * must be in the account's `accelerators` allow-list.
 */
export async function chooseCompute(ctx: HandlerContext, params: ComputeParams, kind: "job" | "schedule"): Promise<ComputeChoice> {
  const options = ctx.deps.options
  if (params.template !== undefined && (params.machine !== undefined || params.accelerator !== undefined)) {
    throw new ColabError("INPUT_INVALID", "A template brings its own machine and accelerator, so machine and accelerator cannot be set with it.", { next: "Drop machine and accelerator, or drop the template." })
  }
  const timeoutMinutes = params.timeoutMinutes ?? options.jobTimeoutMinutes
  if (timeoutMinutes > options.jobTimeoutMinutes) {
    throw new ColabError("INPUT_INVALID", `timeoutMinutes (${timeoutMinutes}) is over jobTimeoutMinutes (${options.jobTimeoutMinutes}).`, {
      next: `Use ${options.jobTimeoutMinutes} minutes or less, or raise jobTimeoutMinutes in the plugin's options.`,
    })
  }
  let machine: string
  let accelerator: string | undefined
  let acceleratorCount: number | undefined
  let template: string | undefined
  let source: ComputeChoice["source"] = "customEnvironmentSpec"
  if (params.template !== undefined) {
    await ctx.providerRead(OPERATIONS.templatesList)
    const templates = await ctx.deps.vertex.listTemplates(ctx.account.alias, ctx.call.signal)
    const found = templates.find((entry) => templateName(entry) === params.template || templateName(entry).endsWith(`/notebookRuntimeTemplates/${params.template}`))
    if (!found) {
      throw new ColabError("NOT_FOUND", `No notebook runtime template matches "${params.template}".`, { next: "Use a template id colab_specs lists; templates are read-only in v0.1.0." })
    }
    const compute = templateMachine(found)
    if (!compute.machine) throw new ColabError("ESTIMATE_UNKNOWN", "The template names no machine type, so its cost cannot be estimated.", { next: "Use a template with a machineSpec, or name machine instead." })
    machine = compute.machine
    accelerator = compute.accelerator
    acceleratorCount = compute.acceleratorCount
    template = templateName(found)
    source = "template"
  } else {
    machine = params.machine ?? options.enterpriseMachine
    accelerator = params.accelerator !== undefined && params.accelerator.toUpperCase() !== "NONE" ? params.accelerator : undefined
    if (params.accelerator !== undefined && acceleratorType(params.accelerator) === undefined && params.accelerator.toUpperCase() !== "NONE") {
      throw new ColabError("INPUT_INVALID", `"${params.accelerator}" is not an accelerator the price table knows.`, { next: "Use NONE, T4, L4, A100, A100_80GB, V100, H100 or H100_MEGA, or a full Vertex accelerator type." })
    }
  }
  const region = ctx.account.region
  if (!region) throw new ColabError("PROJECT_REQUIRED", "The enterprise account has no region, so its endpoint and price region are unknown.", { next: "Set accounts.<alias>.region in opencode.json." })
  const price = priceOf({ machine, ...(accelerator !== undefined ? { accelerator } : {}), ...(acceleratorCount !== undefined ? { acceleratorCount } : {}), region, ...(options.rates !== undefined ? { rates: options.rates } : {}) })
  if (!price) {
    const gaps = priceGaps({ machine, ...(accelerator !== undefined ? { accelerator } : {}), region, ...(options.rates !== undefined ? { rates: options.rates } : {}) })
    // Outside the table's region, every component (machine, accelerator, disk) needs a rate: never mix regions (R2).
    const where =
      region === PRICES_REGION
        ? ""
        : gaps.length > 0
          ? ` The rates option has no ${gaps.map((gap) => `"${gap}"`).join(", ")} rate for ${region}, so an estimate would mix regions.`
          : ` The table prices ${PRICES_REGION}; ${region} needs its own rates.`
    throw new ColabError("ESTIMATE_UNKNOWN", `The machine "${machine}"${accelerator !== undefined ? ` with ${accelerator}` : ""} is not priced for ${region} from the ${PRICES_AS_OF} table.${where}`, {
      next:
        region === PRICES_REGION
          ? `Pick a priced machine (e2-standard-4, n1-standard-4, n2-standard-4, g2-standard-8, a2-highgpu-1g or a3-highgpu-1g) and an accelerator it carries, or add "${machine}" to the rates option.`
          : `Add ${gaps.length > 0 ? gaps.map((gap) => `"${gap}"`).join(", ") : `"${machine}"`} to the rates option at the ${region} rate (rate "disk" is USD per GiB-hour), or use a ${PRICES_REGION} account.`,
    })
  }
  // The allow-list covers a machine's own GPU (g2's L4, a2's A100) as well as a named one (design §8.6).
  const short = acceleratorShort(price.accelerator)
  if (!options.accelerators.includes(short)) {
    throw new ColabError("ACCELERATOR_NOT_ALLOWED", `The ${kind}'s compute uses ${short}, which is not in the accelerators option (${options.accelerators.join(", ")}).`, {
      next: `Pick an allowed machine, or the person may add ${short} to accelerators in the plugin's options.`,
    })
  }
  return { machine, accelerator: price.accelerator, acceleratorCount: price.acceleratorCount, template, timeoutMinutes, price, source, region }
}

export interface CostCheck {
  readonly usdPerHour: number
  readonly timeoutMinutes: number
  readonly maxComputeUsd: number
  readonly capUsd: number
  readonly ceilingUsd: number
  readonly pricesRegion: string
}

/** The estimate against the call's `maxUsd`, the account cap and the ceiling (design §8.6: COST_CAP). */
export function checkCost(choice: ComputeChoice, maxUsd: number | undefined, ctx: HandlerContext): CostCheck {
  const options = ctx.deps.options
  const capUsd = maxUsd ?? options.maxJobUsd
  if (capUsd > options.maxJobUsdCeiling) {
    throw new ColabError("COST_CAP", `maxUsd ($${capUsd}) is over maxJobUsdCeiling ($${options.maxJobUsdCeiling}).`, { next: `Pass maxUsd of $${options.maxJobUsdCeiling} or less, and lower the machine or timeout to fit it.` })
  }
  const maxComputeUsd = Number((choice.price.usdPerHour * (choice.timeoutMinutes / 60)).toFixed(4))
  if (maxComputeUsd > capUsd) {
    throw new ColabError("COST_CAP", `The worst case is $${maxComputeUsd.toFixed(2)} (${choice.machine} at $${choice.price.usdPerHour.toFixed(2)}/h for ${choice.timeoutMinutes} min), over the $${capUsd.toFixed(2)} cap.`, {
      next: `Use a smaller machine or a shorter timeout, or pass maxUsd up to $${options.maxJobUsdCeiling}.`,
    })
  }
  return { usdPerHour: choice.price.usdPerHour, timeoutMinutes: choice.timeoutMinutes, maxComputeUsd, capUsd, ceilingUsd: options.maxJobUsdCeiling, pricesRegion: PRICES_REGION }
}

export interface NotebookForJob {
  readonly source: "path" | "gcs"
  /** Project-relative path, or the gs:// uri. */
  readonly ref: string
  readonly cells: number
  readonly hash: string
  readonly secrets: SecretScreen
  readonly bytes: Uint8Array
  readonly notebook: Notebook
}

/** Read a job's notebook (a local file, or a GCS object) for the preview and again at commit; NOTEBOOK_INVALID if not nbformat 4. */
export async function notebookForJob(ctx: HandlerContext, notebook: { readonly path?: string; readonly gcs?: string }): Promise<NotebookForJob> {
  if (notebook.path !== undefined) {
    const target = resolveLocal(ctx.deps.directory, notebook.path, ctx.deps.options.allowedRoots)
    let bytes: Uint8Array
    try {
      bytes = new Uint8Array(readFileSync(target))
    } catch {
      throw new ColabError("NOT_FOUND", "The notebook file was not found.", { next: "Check the path; colab_find lists notebooks in the workspace." })
    }
    if (bytes.length > ctx.deps.options.maxDownloadBytes) throw new ColabError("FILE_TOO_LARGE", "The notebook file is over maxDownloadBytes.")
    const parsed = parseNotebook(bytes)
    return { source: "path", ref: projectPath(ctx.deps.directory, target), cells: parsed.cells.length, hash: sha256Of(bytes), secrets: screenNotebook(parsed), bytes, notebook: parsed }
  }
  if (notebook.gcs === undefined) throw new ColabError("INPUT_INVALID", "A job needs a notebook: a local path, or a gcs uri.")
  await ctx.providerRead(OPERATIONS.storageObjectsGet)
  const bytes = await ctx.deps.gcs.read(ctx.account.alias, notebook.gcs, ctx.call.signal)
  if (bytes.length > ctx.deps.options.maxDownloadBytes) throw new ColabError("FILE_TOO_LARGE", "The notebook object is over maxDownloadBytes.")
  const parsed = parseNotebook(bytes)
  return { source: "gcs", ref: notebook.gcs, cells: parsed.cells.length, hash: sha256Of(bytes), secrets: screenNotebook(parsed), bytes, notebook: parsed }
}

/** The preview's notebook field: counts, the hash and the screen — never cell text (design §7.2, §7.5). */
export const describeNotebook = (notebook: NotebookForJob) => ({
  source: notebook.source,
  ref: notebook.ref,
  cells: notebook.cells,
  sha256: notebook.hash,
  secrets: { found: notebook.secrets.found, kinds: [...notebook.secrets.kinds] },
})

/** The labels on a job, and on the job request inside a schedule (`Schedule` has no labels, design §7.2). */
export const labelsFor = (sessionId: string) => ({ oc_plugin: "colab", oc_session: sessionLabel(sessionId) })

/** A schedule's compute, filling in a template's machine when the job request names only the template. */
export async function scheduleCompute(ctx: HandlerContext, schedule: EnterpriseSchedule, cache: Map<string, ComputeSpec> = new Map()): Promise<ComputeSpec> {
  const compute = computeOfSchedule(schedule)
  if (compute.machine !== undefined || compute.template === undefined) return compute
  const cached = cache.get(compute.template)
  if (cached) return { ...compute, ...cached }
  await ctx.providerRead(OPERATIONS.templatesList)
  const templates = await ctx.deps.vertex.listTemplates(ctx.account.alias, ctx.call.signal)
  const found = templates.find((template) => template.name === compute.template)
  const machineSpec = (found?.machineSpec ?? {}) as Record<string, unknown>
  const resolved: ComputeSpec = {
    ...(typeof machineSpec.machineType === "string" ? { machine: machineSpec.machineType } : {}),
    ...(typeof machineSpec.acceleratorType === "string" ? { accelerator: machineSpec.acceleratorType } : {}),
    ...(typeof machineSpec.acceleratorCount === "number" ? { acceleratorCount: machineSpec.acceleratorCount } : {}),
  }
  cache.set(compute.template, resolved)
  return { ...compute, ...resolved }
}

/** Google's default when a job or schedule names no `executionTimeout` (Vertex v1 discovery: 86400 s). */
export const GOOGLE_DEFAULT_TIMEOUT_SECONDS = 86_400

export interface ScheduleCost {
  readonly usdPerHour?: number
  readonly perRun?: number
  readonly perMonth?: number
  readonly timeoutMinutes?: number
  /** "job request" when the schedule names its own timeout; "google-default" for Google's 24 h. */
  readonly timeoutSource?: "job request" | "google-default"
  readonly pricesRegion: string
  readonly machine?: string
  /** The rates keys missing for an outside-the-table region; empty when priced. */
  readonly gaps?: readonly string[]
}

/**
 * A schedule's worst case: $/h × its own timeout (or Google's 24 h default when it names none), per run, and that
 * times the runs in the next 30 days. Priced from the us-central1 table for a us-central1 account, or by `rates`.
 */
export function scheduleCost(schedule: EnterpriseSchedule, ctx: HandlerContext, compute: ComputeSpec | undefined): ScheduleCost {
  const spec = compute ?? computeOfSchedule(schedule)
  if (!spec.machine) return { pricesRegion: PRICES_REGION }
  const input = { machine: spec.machine, ...(spec.accelerator !== undefined ? { accelerator: spec.accelerator } : {}), ...(spec.acceleratorCount !== undefined ? { acceleratorCount: spec.acceleratorCount } : {}), region: ctx.account.region, ...(ctx.deps.options.rates !== undefined ? { rates: ctx.deps.options.rates } : {}) }
  const price = priceOf(input)
  if (!price) return { pricesRegion: PRICES_REGION, machine: spec.machine, gaps: priceGaps(input) }
  const timeoutSeconds = spec.timeoutSeconds ?? GOOGLE_DEFAULT_TIMEOUT_SECONDS
  const timeoutMinutes = Math.round(timeoutSeconds / 60)
  const perRun = price.usdPerHour * (timeoutSeconds / 3600)
  let perMonth = perRun
  try {
    const cron = parseCron(schedule.cron)
    const now = ctx.deps.clock.now()
    perMonth = perRun * Math.max(1, occurrencesBetween(cron, now, new Date(now.getTime() + 30 * 86_400_000)))
  } catch {
    // A cron another client wrote may not parse; the per-run worst case still holds.
    perMonth = perRun
  }
  return { usdPerHour: price.usdPerHour, perRun, perMonth, timeoutMinutes, timeoutSource: spec.timeoutSeconds !== undefined ? "job request" : "google-default", pricesRegion: PRICES_REGION, machine: spec.machine }
}

/**
 * A schedule plan's cap check (review M4): the per-run worst case against `maxJobUsd`, with `ESTIMATE_UNKNOWN` when the
 * compute cannot be priced (a foreign machine, or a region the table does not cover). Used on create, update and resume.
 */
export function checkScheduleCost(cost: ScheduleCost, maxUsd: number | undefined, ctx: HandlerContext): ScheduleCost & { readonly capUsd: number } {
  const options = ctx.deps.options
  const capUsd = maxUsd ?? options.maxJobUsd
  if (capUsd > options.maxJobUsdCeiling) throw new ColabError("COST_CAP", `maxUsd ($${capUsd}) is over maxJobUsdCeiling ($${options.maxJobUsdCeiling}).`, { next: `Pass maxUsd of $${options.maxJobUsdCeiling} or less.` })
  if (cost.perRun === undefined) {
    const gaps = cost.gaps ?? []
    throw new ColabError("ESTIMATE_UNKNOWN", `The schedule's machine${cost.machine !== undefined ? ` "${cost.machine}"` : ""} cannot be priced for ${ctx.account.region}: ${gaps.length > 0 ? `the rates option has no ${gaps.map((gap) => `"${gap}"`).join(", ")} rate, so an estimate would mix regions` : `the ${PRICES_REGION} table does not cover it`}.`, {
      next: gaps.length > 0 ? `Add ${gaps.map((gap) => `"${gap}"`).join(", ")} to the rates option at the ${ctx.account.region} rate ("disk" is USD per GiB-hour), or use a ${PRICES_REGION} account.` : "Use a priced machine in the table's region, or add its rates.",
    })
  }
  if (cost.perRun > capUsd) {
    throw new ColabError("COST_CAP", `Each run's worst case is $${cost.perRun.toFixed(2)} (${cost.timeoutMinutes} min, ${cost.timeoutSource}), over the $${capUsd.toFixed(2)} cap.`, {
      next: `Shorten the schedule's executionTimeout, use a smaller machine, or raise maxJobUsd up to $${options.maxJobUsdCeiling}.`,
    })
  }
  return { ...cost, capUsd }
}

/** How many runs a bound allows between now and its `endTime`, at most `cap`. */
export function runsUntil(cronText: string, ctx: HandlerContext, endTime: string | undefined, cap = 1000): number {
  if (endTime === undefined) return 1
  const until = new Date(Date.parse(endTime))
  if (!Number.isFinite(until.getTime())) return 1
  return occurrencesBetween(parseCron(cronText), ctx.deps.clock.now(), until, cap)
}

/** The next five runs, or none when the cron is not one the plugin can read. */
export function nextRunsOf(schedule: EnterpriseSchedule, ctx: HandlerContext): Date[] {
  try {
    return nextRuns(parseCron(schedule.cron), ctx.deps.clock.now(), 5)
  } catch {
    return []
  }
}

/** The plan's payload, typed. E writes it, so the cast is safe; the commit checks the fields it relies on. */
export const payloadOf = <T>(plan: { readonly payload: Readonly<Record<string, unknown>> }) => plan.payload as unknown as T
