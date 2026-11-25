/**
 * The installed package's manifest and version: the one `capabilities` key in package.json, read from the package on
 * disk so the kit, the host and the plugin all see the same bytes.
 */
import { readFileSync } from "node:fs"
import type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"

interface Package {
  readonly name: string
  readonly version: string
  readonly capabilities: Manifest
}

export const pkg: Package = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as Package
export const manifest: Manifest = pkg.capabilities
export type { Manifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
export const version: string = pkg.version
