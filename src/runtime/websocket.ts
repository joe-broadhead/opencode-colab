/**
 * A kernel WebSocket with custom headers (design H6). Colab's proxy authenticates the upgrade with
 * `X-Colab-Runtime-Proxy-Token`; the browser `WebSocket` API cannot set headers, so this wrapper passes the host
 * runtime's own option object — Node's (undici's) and Bun's `WebSocket` both accept `{ headers }` as the second
 * argument, and the host test proves it inside OpenCode's runtime. Nothing else here is Colab-specific: text frames in,
 * text frames out, an abort that closes the socket, and a queue so a caller can iterate messages as they arrive.
 */
import { ColabError } from "../domain/errors.js"

export interface TextSocket {
  send(text: string): void
  close(): void
  /** True once the socket has closed, however it closed: the next `openSession` by name re-opens it (review M3). */
  isClosed(): boolean
  /** A fresh view of the frames still to come; one consumer at a time, as a kernel session allows one run. */
  readonly messages: () => AsyncIterable<string>
  /** Resolves when the socket has closed, however it closed. */
  readonly closed: Promise<void>
  /** The last close code and reason, for the caller's own error wording; never contains a URL. */
  readonly closeInfo: () => { readonly code?: number; readonly reason?: string }
}

interface Waiter {
  readonly resolve: () => void
}

/** A one-consumer queue of text frames that can also be ended or failed by an abort. */
class Frames {
  private readonly queue: string[] = []
  private waiter: Waiter | undefined
  private done: Error | undefined
  private ended = false

  push(text: string) {
    if (this.ended) return
    this.queue.push(text)
    this.wake()
  }

  end() {
    this.ended = true
    this.wake()
  }

  fail(error: Error) {
    this.done ??= error
    this.ended = true
    this.wake()
  }

  private wake() {
    const waiter = this.waiter
    this.waiter = undefined
    waiter?.resolve()
  }

  async *iterate(): AsyncGenerator<string> {
    for (;;) {
      if (this.done) throw this.done
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.ended) return
      await new Promise<void>((resolve) => {
        this.waiter = { resolve }
      })
    }
  }
}

type HeaderWebSocket = new (url: string, options: { headers: Record<string, string> }) => WebSocket

export interface ConnectOptions {
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  readonly signal: AbortSignal
  readonly connectTimeoutMs?: number
}

/**
 * Opens the socket and waits for the upgrade. A refusal to connect, a timeout or an abort is a `ColabError`, and its
 * message names neither the URL nor a header value.
 */
export async function connectTextSocket(input: ConnectOptions): Promise<TextSocket> {
  const { signal } = input
  if (signal.aborted) throw new ColabError("CANCELLED")
  const Ctor = (globalThis as unknown as { WebSocket?: HeaderWebSocket }).WebSocket
  if (!Ctor) throw new ColabError("UNAVAILABLE", "This runtime has no WebSocket, so the plugin cannot open a kernel channel.")
  const socket = new Ctor(input.url, { headers: { ...input.headers } })
  const frames = new Frames()
  let closeCode: number | undefined
  let closeReason: string | undefined

  const closed = new Promise<void>((resolve) => {
    socket.addEventListener("close", (event) => {
      closeCode = (event as CloseEvent).code
      closeReason = (event as CloseEvent).reason || undefined
      resolve()
    })
  })

  // The opening signal bounds opening only: once the socket is open it lives until close() or the runtime ends, so a
  // Stop on the call that opened it does not kill the next run (review M3).
  const onAbort = () => {
    frames.fail(new ColabError("CANCELLED"))
    try {
      socket.close()
    } catch {
      // Closing a socket that never opened is not an error worth reporting.
    }
  }
  const detach = () => signal.removeEventListener("abort", onAbort)
  signal.addEventListener("abort", onAbort, { once: true })
  let isShut = false

  socket.addEventListener("message", (event: MessageEvent) => {
    const data = (event as MessageEvent).data
    if (typeof data === "string") frames.push(data)
  })
  socket.addEventListener("close", () => {
    detach()
    isShut = true
    frames.end()
  })
  socket.addEventListener("error", () => {
    detach()
    isShut = true
    frames.fail(new ColabError("UNAVAILABLE", "The kernel channel failed to open or dropped."))
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      try {
        socket.close()
      } catch {
        // Ignore: the failure is the timeout, not the close.
      }
      reject(new ColabError("UNAVAILABLE", "The kernel channel did not open in time."))
    }, input.connectTimeoutMs ?? 20_000)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeEventListener("open", onOpen)
      socket.removeEventListener("error", onError)
      signal.removeEventListener("abort", onAbortBeforeOpen)
      detach()
    }
    const onOpen = () => {
      cleanup()
      // Opening is over: the signal must not close the socket any more.
      detach()
      resolve()
    }
    const onError = () => {
      cleanup()
      reject(new ColabError("UNAVAILABLE", "The kernel channel failed to open."))
    }
    const onAbortBeforeOpen = () => {
      cleanup()
      reject(new ColabError("CANCELLED"))
    }
    signal.addEventListener("abort", onAbortBeforeOpen, { once: true })
    socket.addEventListener("open", onOpen, { once: true })
    socket.addEventListener("error", onError, { once: true })
  }).catch((error: unknown) => {
    detach()
    throw error
  })

  return {
    send(text: string) {
      if (isShut) throw new ColabError("KERNEL_DIED", "The kernel channel is closed.")
      socket.send(text)
    },
    close() {
      detach()
      frames.end()
      isShut = true
      try {
        socket.close()
      } catch {
        // Already closed.
      }
    },
    isClosed: () => isShut,
    messages: () => frames.iterate(),
    closed,
    closeInfo: () => ({ ...(closeCode !== undefined ? { code: closeCode } : {}), ...(closeReason !== undefined ? { reason: closeReason } : {}) }),
  }
}
