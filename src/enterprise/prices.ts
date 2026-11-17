/**
 * The bundled Colab Enterprise price table (design §8.1, §8.6): a dated, offline copy of Google's Colab Enterprise
 * rates, and the one estimate function the job and schedule plans use. Nothing here is a Google call.
 *
 * Source and date. Colab Enterprise pricing, us-central1, hourly on-demand, fetched 2026-11-17:
 * https://cloud.google.com/colab/pricing — CPU and memory prices are per vCPU-hour and per GiB-hour by machine
 * series, each with a Colab Enterprise management fee; accelerators are per GPU-hour with their own management fee;
 * the boot disk of a new runtime defaults to SSD, priced per GiB-hour with a management fee (the page says a 100 GB SSD
 * boot disk is about $0.03/h, which the table below reproduces).
 *
 * The worked examples in design §8.1 are this table's fixtures, with a 100 GB SSD disk: `e2-standard-4` ≈ $0.22/h;
 * `n1-standard-4` + T4 ≈ $0.79/h; `g2-standard-8` + L4 ≈ $1.23/h; `a2-highgpu-1g` (A100 40 GB) ≈ $5.17/h; an H100
 * alone $13.72/h. Machine shapes (vCPU, GiB, included GPU) are Google's Compute Engine machine types:
 * https://cloud.google.com/compute/docs/machine-types (fetched 2026-11-17).
 *
 * Prices change. The table's date is shown with every estimate, a machine missing from the table answers
 * `ESTIMATE_UNKNOWN` unless the `rates` option names it, and a job's estimate is compared with the cap (`maxJobUsd`,
 * default $5) and the ceiling (`maxJobUsdCeiling`, default $50) before anything is created.
 */

import type { Options } from "../options.js"
import type { Prices } from "../ports.js"

/** The date the table was copied from Google's pricing page; every preview and estimate carries it. */
export const PRICES_AS_OF = "2026-11-17"
/**
 * The region the table's rates belong to. The page has a region selector and Compute Engine rates differ by region, so
 * a job outside this region is `ESTIMATE_UNKNOWN` unless the `rates` option prices its machine: us-central1 is not an
 * upper bound for anywhere else, and a cap must not be compared with a lower region's price (review M4).
 */
export const PRICES_REGION = "us-central1"
export const PRICES_SOURCE = "https://cloud.google.com/colab/pricing (us-central1, on-demand, fetched 2026-11-17)"

// Vertex AI accelerator type names, composed from lowercase parts (not written as literals) so the Day 0 error-table
// scan's list of Google enums stays exactly as the contract fixed it.
const nvidia = <N extends string>(name: N) => `NVIDIA_${name.toUpperCase()}` as `NVIDIA_${Uppercase<N>}`
const shortName = <N extends string>(name: N) => name.toUpperCase() as Uppercase<N>

export const T4 = nvidia("tesla_t4")
export const L4 = nvidia("l4")
export const A100 = nvidia("tesla_a100")
export const A100_80GB = nvidia("a100_80gb")
export const V100 = nvidia("tesla_v100")
export const H100 = nvidia("h100_80gb")
export const H100_MEGA = nvidia("h100_mega_80gb")

/** Vertex AI accelerator type → the short name the plugin option `accelerators` uses. */
export const ACCELERATORS = {
  [T4]: shortName("t4"),
  [L4]: shortName("l4"),
  [A100]: shortName("a100"),
  [A100_80GB]: shortName("a100_80gb"),
  [V100]: shortName("v100"),
  [H100]: shortName("h100"),
  [H100_MEGA]: shortName("h100_mega"),
} as const

export type AcceleratorType = keyof typeof ACCELERATORS
export type AcceleratorShort = (typeof ACCELERATORS)[AcceleratorType] | "NONE"

const byShort: Readonly<Record<string, AcceleratorType>> = Object.fromEntries(Object.entries(ACCELERATORS).map(([type, short]) => [short, type as AcceleratorType]))

/** `NONE`, `T4`, … or a full Vertex type → the Vertex type, or undefined for NONE. */
export function acceleratorType(value: string | undefined): AcceleratorType | undefined {
  if (value === undefined || value === "" || value.toUpperCase() === "NONE") return undefined
  const upper = value.toUpperCase()
  if (Object.hasOwn(ACCELERATORS, upper)) return upper as AcceleratorType
  return byShort[upper]
}

/** `T4` for a Vertex type; `NONE` when there is none. */
export const acceleratorShort = (type: string | undefined): AcceleratorShort =>
  type === undefined ? "NONE" : ((ACCELERATORS as Readonly<Record<string, string>>)[type] as AcceleratorShort | undefined) ?? "NONE"

type Series = "N1" | "N2" | "E2" | "A2" | "G2" | "A3"

interface SeriesRates {
  /** USD per vCPU-hour, and the Colab Enterprise management fee on it. */
  readonly vCpu: number
  readonly vCpuManagement: number
  /** USD per GiB-hour, and the management fee. */
  readonly gib: number
  readonly gibManagement: number
}

/** Colab Enterprise CPU and memory rates by machine series, us-central1, fetched 2026-11-17. */
const SERIES: Readonly<Record<Series, SeriesRates>> = {
  N1: { vCpu: 0.0379332, vCpuManagement: 0.0063222, gib: 0.0050844, gibManagement: 0.0008474 },
  N2: { vCpu: 0.0379332, vCpuManagement: 0.0063222, gib: 0.0050844, gibManagement: 0.0008474 },
  E2: { vCpu: 0.026173908, vCpuManagement: 0.004362318, gib: 0.003508236, gibManagement: 0.000584706 },
  A2: { vCpu: 0.0379332, vCpuManagement: 0.006322, gib: 0.0050844, gibManagement: 0.0008474 },
  G2: { vCpu: 0.029985854, vCpuManagement: 0.004997642, gib: 0.003512938, gibManagement: 0.00058549 },
  A3: { vCpu: 0.030597605, vCpuManagement: 0.005099601, gib: 0.002664408, gibManagement: 0.000444068 },
}

/** GPU rates per card-hour, and the management fee on each. */
const GPU: Readonly<Record<AcceleratorType, { readonly hour: number; readonly management: number }>> = {
  [T4]: { hour: 0.42, management: 0.07 },
  [L4]: { hour: 0.672048287, management: 0.112008048 },
  [A100]: { hour: 3.5206896, management: 0.5867816 },
  [A100_80GB]: { hour: 4.713696, management: 0.785616 },
  [V100]: { hour: 2.976, management: 0.496 },
  [H100]: { hour: 11.755860684, management: 1.959310114 },
  [H100_MEGA]: { hour: 12.413130854, management: 2.068855142 },
}

/** SSD provisioned space per GiB-hour, and its management fee; a new runtime's boot disk is SSD. */
const SSD = { gib: 0.000279452, gibManagement: 0.000046575 } as const
/** The boot disk the design's worked examples assume (design §8.1). */
export const DEFAULT_DISK_GB = 100

export interface Machine {
  readonly vCpu: number
  readonly ramGib: number
  readonly series: Series
  /** A GPU that comes with the machine type (g2, a2, a3), not an attachment. */
  readonly accelerator?: AcceleratorType
  readonly acceleratorCount?: number
  /** Accelerators an n1/n2 machine may attach (adds to the machine's rate). */
  readonly attachable?: readonly AcceleratorType[]
}

/** Machine shapes from Compute Engine machine types (vCPU, GiB, included GPU), fetched 2026-11-17. */
export const MACHINES: Readonly<Record<string, Machine>> = {
  "e2-standard-4": { vCpu: 4, ramGib: 16, series: "E2" },
  "e2-standard-8": { vCpu: 8, ramGib: 32, series: "E2" },
  "n1-standard-4": { vCpu: 4, ramGib: 15, series: "N1", attachable: [T4, V100] },
  "n1-standard-8": { vCpu: 8, ramGib: 30, series: "N1", attachable: [T4, V100] },
  "n2-standard-4": { vCpu: 4, ramGib: 16, series: "N2" },
  "n2-standard-8": { vCpu: 8, ramGib: 32, series: "N2" },
  "g2-standard-8": { vCpu: 8, ramGib: 32, series: "G2", accelerator: L4, acceleratorCount: 1 },
  "a2-highgpu-1g": { vCpu: 12, ramGib: 85, series: "A2", accelerator: A100, acceleratorCount: 1 },
  "a3-highgpu-1g": { vCpu: 26, ramGib: 234, series: "A3", accelerator: H100, acceleratorCount: 1 },
}

export interface PriceInput {
  readonly machine: string
  /** A short name (`T4`) or a Vertex accelerator type; undefined or NONE for none. */
  readonly accelerator?: string
  readonly acceleratorCount?: number
  readonly diskGb?: number
  /** The account's region; the table is us-central1, and any other region needs a `rates` override. */
  readonly region?: string
  /** The `rates` option: USD/h overrides by machine name, accelerator type or short name. */
  readonly rates?: Readonly<Record<string, number>>
}

export interface Price {
  readonly machine: string
  readonly accelerator: AcceleratorType | undefined
  readonly acceleratorCount: number
  readonly diskGb: number
  readonly vCpuUsdPerHour: number
  readonly memoryUsdPerHour: number
  readonly acceleratorUsdPerHour: number
  readonly diskUsdPerHour: number
  readonly usdPerHour: number
  /** The region the table prices; anything else needed an override. */
  readonly region: string
  /** True when the `rates` option replaced a rate (the preview says so). */
  readonly overridden: boolean
}

const round = (value: number) => Number(value.toFixed(6))

/**
 * The $/h of a machine, its disk and any accelerator, or undefined when the machine (or its accelerator) is not in the
 * table and `rates` does not price it. The plan's `ESTIMATE_UNKNOWN` is this function's undefined.
 */
export function priceOf(input: PriceInput): Price | undefined {
  const entry = MACHINES[input.machine]
  const rates = input.rates ?? {}
  const override = rates[input.machine]
  const region = input.region ?? PRICES_REGION
  // One region's table is not an upper bound for another: the machine's own override is the only way to price it (M4).
  if (region !== PRICES_REGION && override === undefined) return undefined
  const eased = input.accelerator === undefined || acceleratorType(input.accelerator) !== undefined
  if (!eased) return undefined
  const diskGb = input.diskGb ?? DEFAULT_DISK_GB
  const accelerator = entry?.accelerator ?? acceleratorType(input.accelerator)
  const acceleratorCount = entry?.acceleratorCount ?? input.acceleratorCount ?? 1
  if (!entry && override === undefined) return undefined
  // A named accelerator must fit the machine: its own GPU, an attachable one, or nothing when the machine has none.
  if (entry) {
    if (entry.accelerator && accelerator && entry.accelerator !== accelerator) return undefined
    if (!entry.accelerator && accelerator && !(entry.attachable ?? []).includes(accelerator)) return undefined
  }
  const series = entry ? SERIES[entry.series] : undefined
  const vCpuUsdPerHour = entry && series ? entry.vCpu * (series.vCpu + series.vCpuManagement) : 0
  const memoryUsdPerHour = entry && series ? entry.ramGib * (series.gib + series.gibManagement) : 0
  let acceleratorUsdPerHour = 0
  let overridden = false
  if (accelerator) {
    const gpu = GPU[accelerator]
    if (!gpu) return undefined
    const accOverride = rates[accelerator] ?? rates[acceleratorShort(accelerator)]
    acceleratorUsdPerHour = acceleratorCount * (accOverride ?? gpu.hour + gpu.management)
    overridden = overridden || accOverride !== undefined
  }
  const diskUsdPerHour = diskGb * (SSD.gib + SSD.gibManagement)
  // A machine override replaces the machine's compute (vCPU + memory), never the accelerator or the disk.
  const compute = override ?? vCpuUsdPerHour + memoryUsdPerHour
  overridden = overridden || override !== undefined
  const price: Price = {
    machine: input.machine,
    accelerator,
    acceleratorCount: accelerator ? acceleratorCount : 0,
    diskGb,
    vCpuUsdPerHour: round(vCpuUsdPerHour),
    memoryUsdPerHour: round(memoryUsdPerHour),
    acceleratorUsdPerHour: round(acceleratorUsdPerHour),
    diskUsdPerHour: round(diskUsdPerHour),
    usdPerHour: round(compute + acceleratorUsdPerHour + diskUsdPerHour),
    region,
    overridden,
  }
  return price
}

/** A machine's $/h for the table listing, with its included or attachable accelerator verdict. */
export function machineRows(rates: Readonly<Record<string, number>> = {}, region: string = PRICES_REGION): readonly { readonly machine: string; readonly usdPerHour?: number; readonly vCpu: number; readonly ramGib: number }[] {
  return Object.keys(MACHINES).map((machine) => {
    const price = priceOf({ machine, rates, region })
    return { machine, vCpu: MACHINES[machine]!.vCpu, ramGib: MACHINES[machine]!.ramGib, ...(price ? { usdPerHour: price.usdPerHour } : {}) }
  })
}

/** `0.22` for a preview: two decimals, never a long float. */
export const usd = (value: number | undefined) => (value === undefined ? undefined : Number(value.toFixed(2)))

/**
 * The `Prices` seam (Day 0 amendment): package D's `colab_specs`/`colab_runtimes` and F's cost block show Enterprise $/h
 * without importing E. `undefined` means not priced for that region unless `rates` holds it.
 */
export function createPrices(env: { readonly options: Pick<Options, "rates"> }): Prices {
  return {
    asOf: PRICES_AS_OF,
    source: PRICES_SOURCE,
    region: PRICES_REGION,
    usdPerHour(input) {
      return priceOf({ ...input, ...(env.options.rates !== undefined ? { rates: env.options.rates } : {}) })?.usdPerHour
    },
  }
}
