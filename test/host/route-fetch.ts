// Replaces globalThis.fetch for this test process, as opencode-github's host tests do. Day 0 makes no Google call, so no
// host is routed yet; packages add loopback fakes for Google's hosts here. Loopback is allowed only to a fake. Every
// other request fails with EXTERNAL_FETCH_BLOCKED and is recorded, so a test can assert that the host never tried to
// leave the machine.

const ROUTED: readonly ((url: URL) => boolean)[] = []

export interface FetchRouter {
  /** A fake's origin while a host runs; undefined blocks every request. */
  target: string | undefined
  /** Origins of fakes that have closed. */
  readonly retired: Set<string>
  /** The origin and path of every blocked request. */
  readonly blocked: string[]
  /** Blocked requests to a closed fake: retries a closed host had already scheduled. */
  readonly stale: string[]
  restore(): void
}

export function routeFetch(): FetchRouter {
  const original = globalThis.fetch
  const router: FetchRouter = {
    target: undefined,
    retired: new Set(),
    blocked: [],
    stale: [],
    restore: () => {
      globalThis.fetch = original
    },
  }
  const routed = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const target = router.target
    let destination: string | undefined
    if (target && ROUTED.some((matches) => url.protocol === "https:" && matches(url))) destination = `${target}${url.pathname}${url.search}`
    else if (target && url.origin === target) destination = url.href
    if (!destination) {
      ;(router.retired.has(url.origin) ? router.stale : router.blocked).push(`${url.origin}${url.pathname}`)
      throw new Error(`EXTERNAL_FETCH_BLOCKED: the host test does not allow requests to ${url.origin}`)
    }
    // No second hop: a redirect would leave the routed origin.
    return original(new Request(destination, request), { redirect: "error" })
  }
  globalThis.fetch = Object.assign(routed, { preconnect: () => undefined }) as typeof fetch
  return router
}
