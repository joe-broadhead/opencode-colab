// The per-runtime owner lease (review round 4 M5, LOW 1): one process at a time, a stale lease is claimable, and the
// session ids the owner created are remembered so a copied nonce name is not adopted.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { createOwnerLease } from "../../src/provider/runtime/lease.js"

const dirs: string[] = []
const dir = () => {
  const made = mkdtempSync(join(tmpdir(), "colab-lease-test-"))
  dirs.push(made)
  return made
}

afterEach(() => {
  for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true })
})

const RUNTIME = "oc-01jleasetest00000000000"

describe("the owner lease", () => {
  it("lets one process own a runtime and refuses another live one without touching the first", async () => {
    const folder = dir()
    const first = createOwnerLease({ dir: folder, pid: process.pid })
    const second = createOwnerLease({ dir: folder, pid: process.ppid })
    expect(await first.claim(RUNTIME)).toEqual({ owner: true })
    expect(await second.claim(RUNTIME)).toEqual({ owner: false, holder: process.pid })
    expect(await first.claim(RUNTIME)).toEqual({ owner: true })
    first.dispose()
    second.dispose()
  })

  it("takes a lease whose process is gone, and one whose heartbeat is older than the stale window", async () => {
    const folder = dir()
    const dead = createOwnerLease({ dir: folder, pid: 999_999 })
    expect(await dead.claim(RUNTIME)).toEqual({ owner: true })
    dead.dispose()
    // The dead process is gone, so the next one takes it even though the timestamp is fresh.
    const next = createOwnerLease({ dir: folder, pid: process.pid })
    expect(await next.claim(RUNTIME)).toEqual({ owner: true })
    next.dispose()

    // A live process whose heartbeat is older than the window is stale too.
    const staleRuntime = "oc-01jleaseteststale000000000"
    writeFileSync(join(folder, `${staleRuntime}.json`), JSON.stringify({ pid: process.ppid, at: 1_000, sessions: {} }))
    const taker = createOwnerLease({ dir: folder, pid: process.pid, now: () => 1_000_000 })
    expect(await taker.claim(staleRuntime)).toEqual({ owner: true })
    taker.dispose()
  })

  it("remembers the session ids the owner created, and forgets them on release", async () => {
    const folder = dir()
    const lease = createOwnerLease({ dir: folder, pid: process.pid })
    await lease.claim(RUNTIME)
    await lease.remember(RUNTIME, "oc-nonce-1-run", "session-1")
    expect(await lease.known(RUNTIME)).toEqual({ "oc-nonce-1-run": "session-1" })
    expect(JSON.parse(readFileSync(join(folder, `${RUNTIME}.json`), "utf8"))).toMatchObject({ pid: process.pid })
    await lease.forget(RUNTIME)
    expect(await lease.known(RUNTIME)).toEqual({})
    await lease.release(RUNTIME)
    expect(await lease.claim(RUNTIME)).toEqual({ owner: true })
    lease.dispose()
  })

  it("heartbeats while it is held, so a long run is not taken by another process", async () => {
    const folder = dir()
    let clock = 5_000
    const lease = createOwnerLease({ dir: folder, pid: process.pid, heartbeatMs: 10, now: () => clock })
    await lease.claim(RUNTIME)
    const written = () => JSON.parse(readFileSync(join(folder, `${RUNTIME}.json`), "utf8")).at as number
    expect(written()).toBe(5_000)
    clock = 9_000
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(written()).toBe(9_000)
    lease.dispose()
  })

  it("works with no directory at all, which is what a test's in-memory ledger gives", async () => {
    const lease = createOwnerLease({ pid: process.pid })
    expect(await lease.claim(RUNTIME)).toEqual({ owner: true })
    await lease.remember(RUNTIME, "oc-nonce-1-run", "session-1")
    expect(await lease.known(RUNTIME)).toEqual({ "oc-nonce-1-run": "session-1" })
    await lease.release(RUNTIME)
    expect(await lease.known(RUNTIME)).toEqual({})
    lease.dispose()
  })
})
