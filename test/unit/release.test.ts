import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ColabError } from "../../src/domain/errors.js"
import { guardGoogleFetch, isTaggedRelease, NOT_RELEASED_DETAIL, NOT_RELEASED_NEXT, simulateTaggedRelease } from "../../src/release.js"

describe("a source install does not call Google", () => {
  afterEach(() => simulateTaggedRelease(undefined))

  it("is not a tagged release in this checkout, and a test can simulate one", () => {
    simulateTaggedRelease(undefined)
    expect(isTaggedRelease()).toBe(false)
    simulateTaggedRelease(true)
    expect(isTaggedRelease()).toBe(true)
  })

  it("refuses a Google host before the fetch runs, and a simulated release keeps the handler", async () => {
    let called = false
    const base = (async () => {
      called = true
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const refuse = () => {
      throw new ColabError("NOT_RELEASED", NOT_RELEASED_DETAIL, { next: NOT_RELEASED_NEXT })
    }
    const blocked = guardGoogleFetch(base, false, refuse)
    expect(() => blocked("https://colab.googleapis.com/v1/notebooks")).toThrow(/^NOT_RELEASED: /)
    expect(called).toBe(false)
    await expect(blocked("http://127.0.0.1:9/health")).resolves.toBeInstanceOf(Response)
    expect(called).toBe(true)
    called = false
    const released = guardGoogleFetch(base, true, refuse)
    await released("https://colab.googleapis.com/v1/notebooks")
    expect(called).toBe(true)
  })
})

describe("the host's install info decides, and a checkout's tag is the fallback", () => {
  afterEach(() => simulateTaggedRelease(undefined))

  it("reads a semver tag on the package target, and refuses a branch or a mismatched version", () => {
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab#v0.0.1", version: "0.0.1" })).toBe(true)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab#v0.0.1" })).toBe(true)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab#master" })).toBe(false)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab" })).toBe(false)
    expect(isTaggedRelease({ type: "package", target: "github:joe-broadhead/opencode-colab#v0.0.1", version: "0.0.2" })).toBe(false)
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
