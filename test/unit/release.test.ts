import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ColabError } from "../../src/domain/errors.js"
import {
  createReleaseGate,
  guardGoogleFetch,
  isTaggedRelease,
  NOT_RELEASED_DETAIL,
  NOT_RELEASED_NEXT,
  simulateTaggedRelease,
  type InstallSource,
} from "../../src/release.js"

// The host's own report, as stock OpenCode 2.3.2 sends it: the tag is in the spec, and `version` is the resolved commit.
const SHA = "8fa625bce989ff7c47a586eaa39340374ba43434"
const packageSource = (ref: string): InstallSource => ({ type: "package", target: `git+file:///cache/opencode-colab#${ref}`, version: SHA })
const listOf = (...items: { id: string; source: InstallSource }[]) => async () => ({ location: { directory: "/p" }, data: items })

describe("a source install does not call Google", () => {
  afterEach(() => simulateTaggedRelease(undefined))

  it("is not a tagged release in this checkout, and a test can simulate one", () => {
    simulateTaggedRelease(undefined)
    expect(isTaggedRelease()).toBe(false)
    simulateTaggedRelease(true)
    expect(isTaggedRelease()).toBe(true)
  })

  it("reads the tag from a package install's spec, not its commit version", () => {
    expect(isTaggedRelease(packageSource("v0.0.1"))).toBe(true)
    expect(isTaggedRelease(packageSource("v0.0.1-rc.1"))).toBe(true)
    expect(isTaggedRelease(packageSource("master"))).toBe(false)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab" })).toBe(false)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab", version: "0.0.1" })).toBe(false)
    expect(isTaggedRelease({ type: "builtin" })).toBe(false)
    expect(isTaggedRelease({ type: "sdk" })).toBe(false)
    expect(isTaggedRelease({})).toBe(false)
  })

  it("falls back to the checkout's exact git tag: tagged is a release, untagged is not", () => {
    const dir = mkdtempSync(join(tmpdir(), "colab-release-"))
    try {
      const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      git("init", "--quiet")
      git("-c", "user.name=release test", "-c", "user.email=release@example.invalid", "commit", "--allow-empty", "-qm", "checkout")
      expect(isTaggedRelease({ type: "local", path: dir })).toBe(false)
      git("tag", "v0.0.1")
      expect(isTaggedRelease({ type: "local", path: dir })).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the release gate reads the host's report when the entry is there", () => {
  afterEach(() => simulateTaggedRelease(undefined))

  it("is gated while the host does not list the plugin, then released once it does", async () => {
    let listed = false
    const gate = createReleaseGate("colab.test", () => async () => ({ location: { directory: "/p" }, data: listed ? [{ id: "colab.test", source: packageSource("v0.0.1") }] : [] }))
    expect(await gate.released()).toBe(false) // setup: the host does not list the plugin itself
    listed = true
    expect(await gate.released()).toBe(true) // after setup: the entry carries the tag
    expect(await gate.released()).toBe(true)
  })

  it("stays gated for a package install at a branch, and for a local checkout with no tag", async () => {
    const branch = createReleaseGate("colab.test", () => listOf({ id: "colab.test", source: packageSource("main") }))
    expect(await branch.released()).toBe(false)
    const local = createReleaseGate("colab.test", () => listOf({ id: "colab.test", source: { type: "local", path: tmpdir() } }))
    expect(await local.released()).toBe(false)
  })

  it("honours the test seam over the host's report", async () => {
    simulateTaggedRelease(true)
    const gate = createReleaseGate("colab.test", () => listOf({ id: "colab.test", source: packageSource("main") }))
    expect(await gate.released()).toBe(true)
  })
})

describe("the guarded fetch", () => {
  it("refuses a Google host before the fetch runs, and a released install keeps the handler", async () => {
    let called = false
    const base = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const refuse = () => {
      throw new ColabError("NOT_RELEASED", NOT_RELEASED_DETAIL, { next: NOT_RELEASED_NEXT })
    }
    const blocked = guardGoogleFetch(base, async () => false, refuse)
    await expect(blocked("https://colab.googleapis.com/v1/notebooks")).rejects.toThrow(/^NOT_RELEASED: /)
    expect(called).toBe(false)
    await expect(blocked("http://127.0.0.1:9/health")).resolves.toBeInstanceOf(Response)
    expect(called).toBe(true)
    called = false
    const released = guardGoogleFetch(base, async () => true, refuse)
    await released("https://colab.googleapis.com/v1/notebooks")
    expect(called).toBe(true)
  })
})
