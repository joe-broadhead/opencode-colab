/**
 * The `sources` declaration as package.json ships it, as the contract request in package G's pull request amends it,
 * and the keys a source-contract v0.1.x consumer refuses.
 *
 * **Contract request 1** (Day 0's package.json `sources`; the PR description gives the exact change):
 *
 * - add `input: { source: "runs" }` to `colab.runs` and `input: { source: "runtimes" }` to `colab.runtimes`. A
 *   consumer sends a source exactly the descriptor's `input` plus `account` (source-contract `read`, `prepare`), and the
 *   contract names a page's source by `input.source`, else by the item's id; a page's `source` must be a lowercase
 *   word (`resultProblems`), so without `input` no page of `colab.runs` can pass a consumer's checks or the kit, and
 *   `probe` cannot be called with a source at all (`parseProbeInput`). gws, GitHub, Granola and boxd all declare it.
 * - drop the empty `permission.identity: []` from both items. Jelly and Memory still vendor v0.1.x, which refuses an
 *   empty `identity` (the BigQuery and Databricks rulings; LEAD-NOTES 18 Nov). The probe asserts no identity operation,
 *   so leaving the key out says the same thing.
 *
 * test/unit/sources-declaration.test.ts pins both: it fails when a new refused key appears, and when the shipped block
 * stops differing from the requested one (the request landed), so the pending exception cannot outlive it.
 */
import { readFileSync } from "node:fs"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string; sources: { [key: string]: Json } }

export const PACKAGE_NAME = pkg.name
export const PACKAGE_VERSION = pkg.version

/** package.json `sources`, as shipped. */
export const shippedSources = (): { [key: string]: Json } => structuredClone(pkg.sources)

const INPUT_SOURCE: Readonly<Record<string, string>> = { "colab.runs": "runs", "colab.runtimes": "runtimes" }

/** The shipped block with contract request 1 applied, and nothing else changed. */
export function requestedSources(): { [key: string]: Json } {
  const block = shippedSources()
  for (const item of block["items"] as { [key: string]: Json }[]) {
    const id = String(item["id"])
    if (item["input"] === undefined && INPUT_SOURCE[id]) {
      // Keep `input` right after `tool`, where gws and the others put it.
      const entries = Object.entries(item)
      const at = entries.findIndex(([key]) => key === "tool") + 1
      entries.splice(at, 0, ["input", { source: INPUT_SOURCE[id]! }])
      for (const key of Object.keys(item)) delete item[key]
      Object.assign(item, Object.fromEntries(entries))
    }
    const permission = item["permission"] as { [key: string]: Json }
    if (Array.isArray(permission["identity"]) && permission["identity"].length === 0) delete permission["identity"]
  }
  return block
}

/**
 * Every place in a `sources` block that a v0.1.x consumer refuses (source-contract v0.2.0 CHANGELOG: keys "a plugin
 * declares only after both consumers are on 0.2.0"; SC-SOURCES-BRIEF CORRECTIONS 5): `removals`, `accounts.server`,
 * `identityRules`, `readsIdentity`, an owner's `verified`, an empty `permission.identity`, and a price's `conditions`
 * or `min`. Paths are JSON-path-like, so a failure names where.
 */
export function v01RefusedKeys(value: Json, path = "sources"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => v01RefusedKeys(entry, `${path}[${index}]`))
  if (value === null || typeof value !== "object") return []
  const found: string[] = []
  for (const [key, child] of Object.entries(value)) {
    const at = `${path}.${key}`
    if (key === "removals" || key === "identityRules" || key === "readsIdentity" || key === "verified") found.push(at)
    if (key === "server" && /\.accounts$/.test(path)) found.push(at)
    if (key === "identity" && /\.permission$/.test(path) && Array.isArray(child) && child.length === 0) found.push(`${at} (empty)`)
    if ((key === "conditions" || key === "min") && /\.units\[\d+\]$/.test(path)) found.push(at)
    found.push(...v01RefusedKeys(child, at))
  }
  return found
}
