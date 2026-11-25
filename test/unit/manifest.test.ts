import { describe, expect, test } from "vitest"
import { checkManifest } from "@we-the-rebel-alliance/plugin-contract/manifest"
import { manifest, pkg, version } from "../../src/manifest.js"
import { createHandlers } from "../../src/handlers/index.js"
import { accountsFor } from "../../src/accounts.js"
import { fakeDeps } from "../fakes/index.js"

describe("the manifest", () => {
  test("validates and names one package and 24 methods", () => {
    const checked = checkManifest(manifest)
    expect(checked.ok, checked.ok ? "" : checked.problems.join("; ")).toBe(true)
    expect(pkg.name).toBe("@we-the-rebel-alliance/colab-plugin")
    expect(version).toBe("0.0.0")
    expect(manifest.plugin.name).toBe("colab")
    expect(manifest.plugin.summary.length).toBeLessThanOrEqual(400)
    expect(Object.keys(manifest.methods)).toHaveLength(24)
    expect(manifest.sources.map((source) => source.id)).toEqual(["colab.runs", "colab.runtimes"])
    expect(manifest.actions).toEqual([])
    expect(manifest.events).toEqual({ changed: {} })
    expect(manifest.plugin.summary).not.toMatch(/colab_[a-z]/)
  })

  test("registers exactly the declared methods", () => {
    const { deps } = fakeDeps({ options: { access: "all", accounts: { work: {}, personal: {} } } })
    const profiles = accountsFor(manifest, { accounts: { work: {}, personal: {} } })
    const handlers = createHandlers({ deps, manifest, version, hostVersion: "2.4.1", profiles, problems: [] })
    expect(Object.keys(handlers).sort()).toEqual(Object.keys(manifest.methods).sort())
  })

  test("declares the contract options: access, accounts and allowUntestedHost", () => {
    const properties = manifest.options.properties as Record<string, unknown>
    expect(properties.access).toBeTruthy()
    expect(properties.accounts).toBeTruthy()
    expect(properties.allowUntestedHost).toBeTruthy()
    expect(manifest.accounts?.via).toBe("integration")
  })
})
