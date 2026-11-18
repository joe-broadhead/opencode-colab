/**
 * The `sources` declaration as package.json ships it, and the keys a source-contract v0.1.x consumer refuses.
 * test/unit/sources-declaration.test.ts fails when one of those keys appears in the declaration, a page or a probe.
 */
import { readFileSync } from "node:fs"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string; sources: { [key: string]: Json } }

export const PACKAGE_NAME = pkg.name
export const PACKAGE_VERSION = pkg.version

/** package.json `sources`, as shipped. */
export const shippedSources = (): { [key: string]: Json } => structuredClone(pkg.sources)

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
