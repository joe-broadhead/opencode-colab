/**
 * The proxy in front of a Jupyter server (design §15.2): a token-checking HTTP and WebSocket proxy, in front of a
 * Jupyter Server fake that speaks the REST API and the kernel channel this package uses. It stands in for a Colab
 * runtime in every test here, so nothing in `npm run check` talks to Google.
 *
 * The proxy checks `X-Colab-Runtime-Proxy-Token` and answers 404 when it is missing, wrong or expired, which is how
 * Google's proxy behaves for an expired token (design §1, [3]). The Jupyter fake behind it keeps kernels, sessions,
 * contents and files, answers `execute_request` messages with scripted iopub, and can raise a `colab_request` so a test
 * can see the decline on the wire.
 */
import { createHash, randomUUID } from "node:crypto"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"
import { CREDENTIAL_FILES, GCLOUD_CONFIG_DIR } from "../../src/runtime/discovery.js"
import { PROBE_SENTINEL } from "../../src/runtime/probe.js"

export interface FakeIopub {
  readonly msgType: string
  readonly content: Record<string, unknown>
}

export interface FakeKernelState {
  kernelId: string
  sessionId: string
  executionCount: number
  /** `/proc/mounts` as this runtime sees it: `source|mountpoint|type`, stock entries included. */
  mounts: string[]
  /** Colab's real stock environment, carried so a probe that reads it again fails its tests (review H1). */
  readonly environment: Record<string, string>
  ramBytes: number
  /** The proxy's own connection to the kernel, so a baseline is never mistaken for another client. */
  readonly proxyConnections: number
}

/** The probe kernel's stored baseline, as ipykernel's globals would hold it. */
interface FakeBaseline {
  readonly epoch: string
  readonly mounts: readonly string[]
  readonly files: readonly string[]
  readonly config: unknown
}

export interface FakeJupyterOptions {
  readonly token?: string
  /** Stock Jupyter Server hides dot-paths; `true` is a runtime whose `allow_hidden` is on (design L2). */
  readonly allowHidden?: boolean
  /** The proxy's own connection to every kernel. */
  readonly proxyConnections?: number
}

export interface WireRecord {
  readonly method: string
  readonly path: string
  readonly headers: Readonly<Record<string, string | string[] | undefined>>
}

interface Kernel {
  readonly id: string
  name: string
  executionState: string
  lastActivity: string
  /** Open plugin sockets; the proxy's own connection is added from the state. */
  sockets: number
}

interface Session {
  readonly id: string
  readonly name: string
  readonly path: string
  readonly kernelId: string
}

const now = () => new Date().toISOString()

/** Decodes client frames (text and close), answering pings, and returns what is left of the buffer. */
function readFrames(buffer: Buffer, onText: (text: string) => void, onClose: () => void): Buffer {
  let rest = buffer
  for (;;) {
    if (rest.length < 2) return rest
    const first = rest[0]!
    const second = rest[1]!
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (rest.length < 4) return rest
      length = rest.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (rest.length < 10) return rest
      length = Number(rest.readBigUInt64BE(2))
      offset = 10
    }
    const maskLength = masked ? 4 : 0
    if (rest.length < offset + maskLength + length) return rest
    const mask = masked ? rest.subarray(offset, offset + 4) : undefined
    const payload = Buffer.from(rest.subarray(offset + maskLength, offset + maskLength + length))
    if (mask) for (let index = 0; index < payload.length; index += 1) payload[index] = payload[index]! ^ mask[index % 4]!
    rest = rest.subarray(offset + maskLength + length)
    if (opcode === 0x8) {
      onClose()
      return rest
    }
    if (opcode === 0x1) onText(payload.toString("utf8"))
  }
}

function frame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8")
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload])
  if (payload.length < 65_536) {
    const header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
    return Buffer.concat([header, payload])
  }
  const header = Buffer.alloc(10)
  header[0] = 0x81
  header[1] = 127
  header.writeBigUInt64BE(BigInt(payload.length), 2)
  return Buffer.concat([header, payload])
}

const envelope = (msgType: string, content: Record<string, unknown>, parentMsgId: string, channel = "iopub") => ({
  header: { msg_id: randomUUID(), msg_type: msgType, username: "fake", session: randomUUID(), date: now(), version: "5.3" },
  parent_header: { msg_id: parentMsgId },
  metadata: {},
  content,
  channel,
  buffers: [],
})

export interface FakeJupyter {
  /** The token-checking proxy: what a `ConnectionInfo.url` points at. */
  readonly url: string
  /** The Jupyter fake behind it, for a test that wants to skip the proxy. */
  readonly jupyterUrl: string
  readonly token: string
  readonly requests: WireRecord[]
  /** Every upgrade the proxy saw, with the headers it checked. */
  readonly upgrades: WireRecord[]
  readonly state: FakeKernelState
  readonly contents: Map<string, Uint8Array>
  /** Every `colab_reply` the plugin sent on the stdin channel, parsed. */
  readonly replies: { readonly colab_msg_id?: number; readonly type?: string; readonly error?: string }[]
  readonly stdinReplies: Record<string, unknown>[]
  readonly interrupts: string[]
  /** Watchdog requests, in order: the seconds a start asked for, and cancels. */
  readonly watchdogs: number[]
  readonly watchdogCancels: number
  readonly executed: { readonly code: string; readonly allowStdin: unknown; readonly silent: unknown }[]
  /** The `chunk` numbers a chunked contents write sent, in order. */
  readonly chunksSeen: number[]
  /** Clears the probe kernel's globals and puts the execution count back at 1, as a restart does. */
  restartProbeKernel(): void
  /** Gives the named session a new id under the same name, as another client opening the copied name would. */
  replaceSessionId(sessionName: string): string
  /** Extra sessions a test wants on the runtime (a foreign client's). */
  readonly foreignSessions: Session[]
  /** Extra connections a test wants on a kernel. */
  extraConnections: number
  /** Another token the proxy accepts, for a refresh test. */
  addToken(token: string): void
  /** Stop accepting a token, as an expiry does. */
  revoke(token: string): void
  /** Give the named session a new kernel id, as a restart or a replaced kernel does. */
  replaceKernel(sessionName: string): string
  /** Extra stdout the probe prints, to test the strict parse. */
  probeExtraOutput: string
  /** Scripted iopub per code substring, emitted before idle: `display_data`, `execute_result`, `error`, and so on. */
  emit: Map<string, readonly FakeIopub[]>
  expire(): void
  close(): Promise<void>
}

export async function createFakeJupyter(options: FakeJupyterOptions = {}): Promise<FakeJupyter> {
  const token = options.token ?? "proxy-token-1"
  const accepted = new Set([token])
  let valid = true
  let allowHidden = options.allowHidden ?? false
  const contents = new Map<string, Uint8Array>()
  const kernels = new Map<string, Kernel>()
  const sessions = new Map<string, Session>()
  const requests: WireRecord[] = []
  const upgrades: WireRecord[] = []
  const replies: { colab_msg_id?: number; type?: string; error?: string }[] = []
  const stdinReplies: Record<string, unknown>[] = []
  const interrupts: string[] = []
  const watchdogs: number[] = []
  let watchdogCancels = 0
  const executed: { code: string; allowStdin: unknown; silent: unknown }[] = []
  const foreignSessions: Session[] = []
  let extraConnections = 0
  let probeExtraOutput = ""
  const emit = new Map<string, readonly FakeIopub[]>()
  const sockets = new Set<Duplex>()
  const uploads = new Map<string, Buffer[]>()
  const chunksSeen: number[] = []

  const state: FakeKernelState = {
    kernelId: "",
    sessionId: "",
    executionCount: 0,
    // A stock Colab runtime: container mounts (one of them FUSE) and the ephemeral-credential addresses in the
    // environment. None of this is evidence of a credential (review H1).
    mounts: ["overlay|/|overlay", "proc|/proc|proc", "tmpfs|/dev/shm|tmpfs", "lxcfs|/proc/cpuinfo|fuse.lxcfs"],
    environment: { USE_AUTH_EPHEM: "0", TBE_EPHEM_CREDS_ADDR: "http://169.254.169.254/tbe/ephemeral", TBE_CREDS_ADDR: "http://169.254.169.254/tbe" },
    ramBytes: 96 * 1024 * 1024,
    proxyConnections: options.proxyConnections ?? 1,
  }

  const newKernel = (): Kernel => {
    const kernel: Kernel = { id: `kernel-${kernels.size + 1}-${randomUUID().slice(0, 8)}`, name: "python3", executionState: "idle", lastActivity: now(), sockets: 0 }
    kernels.set(kernel.id, kernel)
    return kernel
  }

  /**
   * What the probe snippet would print, computed from this fake's filesystem, mounts and per-kernel globals — including
   * a restart, which clears them and resets the execution count the way ipykernel does (review M1).
   */
  const baselines = new Map<string, FakeBaseline>()

  /** The probe's recursive view of gcloud's config: every file's relative name, size and content hash (review round 5). */
  const configSnapshot = () => {
    const prefix = `${GCLOUD_CONFIG_DIR}/`
    const names = [...contents.keys()].filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).sort()
    if (names.length === 0) return null
    const digest = createHash("sha256")
    for (const name of names) {
      const bytes = contents.get(prefix + name)!
      digest.update(`${name}:${bytes.byteLength}:${createHash("sha256").update(bytes).digest("hex")}`)
    }
    return { files: names, digest: digest.digest("hex") }
  }

  const driveMount = (mounts: readonly string[]) =>
    mounts.some((entry) => {
      const [source, mount, type] = entry.split("|")
      return Boolean(type?.startsWith("fuse") && `${source}${mount}${type}`.toLowerCase().includes("drive"))
    })

  const probeAnswer = (code: string, kernelId: string): string => {
    const request = JSON.parse(/_OC_REQUEST = (\{[^\n]*\})/.exec(code)?.[1] ?? "{}") as { mode?: string; epoch?: string }
    const files = CREDENTIAL_FILES.filter((path) => contents.has(path))
    if (request.mode === "baseline") {
      baselines.set(kernelId, { epoch: request.epoch ?? "", mounts: [...state.mounts], files, config: configSnapshot() })
      return JSON.stringify({
        mode: "baseline",
        epoch: request.epoch ?? "",
        drive_mount: driveMount(state.mounts),
        files,
        execution_count: state.executionCount,
        ram_bytes: state.ramBytes,
      })
    }
    const stored = baselines.get(kernelId)
    if (!stored) {
      return JSON.stringify({ mode: "compare", epoch: "", epoch_ok: false, restarted: true, drive_mount: false, mounts_changed: false, config_changed: false, added_files: [], execution_count: state.executionCount })
    }
    const config = configSnapshot()
    return JSON.stringify({
      mode: "compare",
      epoch: stored.epoch,
      epoch_ok: stored.epoch === request.epoch,
      restarted: false,
      drive_mount: driveMount(state.mounts),
      mounts_changed: state.mounts.some((entry) => !stored.mounts.includes(entry)),
      config_changed: JSON.stringify(stored.config) !== JSON.stringify(config),
      added_files: files.filter((path) => !stored.files.includes(path)),
      execution_count: state.executionCount,
    })
  }

  const json = (response: ServerResponse, status: number, body: unknown) => {
    const text = JSON.stringify(body)
    response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
    response.end(text)
  }

  const notFound = (response: ServerResponse) => json(response, 404, { message: "Not found", reason: null })

  const hidden = (path: string) => !allowHidden && path.split("/").some((segment) => segment.startsWith("."))

  const sessionView = (session: Session) => ({ id: session.id, name: session.name, path: session.path, type: "notebook", kernel: { id: session.kernelId, name: "python3" } })

  const handle = async (request: IncomingMessage, response: ServerResponse, body: Buffer) => {
    const url = new URL(request.url ?? "/", "http://fake")
    const path = decodeURIComponent(url.pathname.replace(/^\//, ""))
    const method = request.method ?? "GET"
    if (path === "api/kernels" && method === "GET") {
      return json(response, 200, {
        kernels: [...kernels.values()].map((kernel) => ({
          id: kernel.id,
          name: kernel.name,
          execution_state: kernel.executionState,
          last_activity: kernel.lastActivity,
          connections: kernel.sockets + state.proxyConnections + extraConnections,
        })),
      })
    }
    const interrupt = /^api\/kernels\/([^/]+)\/(interrupt|restart)$/.exec(path)
    if (interrupt && method === "POST") {
      const kernel = kernels.get(interrupt[1]!)
      if (!kernel) return notFound(response)
      if (interrupt[2] === "interrupt") interrupts.push(kernel.id)
      else {
        // ipykernel on restart: a new namespace (globals gone) and an execution count back at 1 (review M1).
        kernel.executionState = "idle"
        baselines.delete(kernel.id)
        state.executionCount = 1
      }
      response.writeHead(204)
      return response.end()
    }
    if (path === "api/sessions" && method === "GET") {
      return json(response, 200, { sessions: [...sessions.values(), ...foreignSessions].map(sessionView) })
    }
    if (path === "api/sessions" && method === "POST") {
      const input = JSON.parse(body.toString("utf8") || "{}") as { path?: string; name?: string }
      const kernel = newKernel()
      const session: Session = { id: `session-${randomUUID().slice(0, 8)}`, name: input.name ?? "", path: input.path ?? "", kernelId: kernel.id }
      sessions.set(session.id, session)
      if (session.name.includes("probe")) {
        state.kernelId = kernel.id
        state.sessionId = session.id
        state.executionCount = 1
      }
      return json(response, 201, sessionView(session))
    }
    if (path.startsWith("api/contents/")) {
      const target = path.slice("api/contents/".length)
      if (hidden(target)) return notFound(response)
      if (method === "GET") {
        if (contents.has(target)) {
          const bytes = contents.get(target)!
          return json(response, 200, { type: "file", name: target.split("/").at(-1), path: target, size: bytes.length, format: "text" })
        }
        const prefix = target === "" ? "" : `${target}/`
        const children = [...contents.keys()].filter((name) => name.startsWith(prefix) && name !== target)
        const direct = children.filter((name) => !name.slice(prefix.length).includes("/"))
        if (direct.length === 0 && target !== "") return notFound(response)
        return json(response, 200, {
          type: "directory",
          path: target,
          content: direct.map((name) => ({ name: name.slice(prefix.length), path: name, type: "file", size: contents.get(name)!.length })),
        })
      }
      if (method === "PUT") {
        const input = JSON.parse(body.toString("utf8") || "{}") as { format?: string; content?: string; chunk?: number }
        if (input.format !== "base64" || typeof input.content !== "string") return json(response, 400, { message: "bad contents write" })
        const bytes = Buffer.from(input.content, "base64")
        if (typeof input.chunk === "number") {
          // Jupyter's AsyncLargeFileManager: chunk 1 starts, -1 ends, the pieces in between append.
          chunksSeen.push(input.chunk)
          if (input.chunk === 1) {
            uploads.set(target, [bytes])
            return json(response, 201, { type: "file", path: target, size: bytes.length })
          }
          const parts = uploads.get(target)
          if (!parts) return json(response, 400, { message: "chunk without a first piece" })
          parts.push(bytes)
          if (input.chunk === -1) {
            const whole = Buffer.concat(parts)
            contents.set(target, whole)
            uploads.delete(target)
            return json(response, 201, { type: "file", path: target, size: whole.length })
          }
          return json(response, 201, { type: "file", path: target, size: bytes.length })
        }
        contents.set(target, bytes)
        return json(response, 201, { type: "file", path: target, size: bytes.length })
      }
    }
    if (path.startsWith("files/") && method === "GET") {
      const target = path.slice("files/".length)
      const bytes = contents.get(target)
      if (!bytes) return notFound(response)
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length })
      response.end(bytes)
      return
    }
    return notFound(response)
  }

  /** One kernel channel: scripted iopub per request, and the stdin channel that carries the decline. */
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? "/", "http://fake")
    const match = /^\/api\/kernels\/([^/]+)\/channels$/.exec(url.pathname)
    const kernel = match ? kernels.get(decodeURIComponent(match[1]!)) : undefined
    if (!kernel) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n")
      return
    }
    const key = request.headers["sec-websocket-key"]
    if (typeof key !== "string") {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n")
      return
    }
    const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64")
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    kernel.sockets += 1
    sockets.add(socket)
    let buffer: Buffer = head.length ? Buffer.from(head) : Buffer.alloc(0)
    let awaiting: { readonly msgId: number; readonly parent: string } | undefined
    const send = (message: unknown) => {
      if (!socket.destroyed) socket.write(frame(JSON.stringify(message)))
    }
    const finish = (parent: string, text: string, extra: FakeIopub[] = []) => {
      send(envelope("stream", { name: "stdout", text }, parent))
      for (const message of extra) send(envelope(message.msgType, message.content, parent))
      send(envelope("status", { execution_state: "idle" }, parent))
    }
    const onClose = () => {
      kernel.sockets -= 1
      sockets.delete(socket)
      socket.destroy()
    }
    const onText = (text: string) => {
      let message: { header?: { msg_type?: string; msg_id?: string }; content?: Record<string, unknown>; metadata?: Record<string, unknown>; channel?: string }
      try {
        message = JSON.parse(text) as typeof message
      } catch {
        return
      }
      const parent = message.header?.msg_id ?? randomUUID()
      if (message.header?.msg_type === "input_reply") {
        const value = (message.content as { value?: Record<string, unknown> } | undefined)?.value
        if (value) {
          stdinReplies.push(value)
          replies.push(value as { colab_msg_id?: number; type?: string; error?: string })
        }
        if (awaiting && value?.colab_msg_id === awaiting.msgId) {
          finish(awaiting.parent, "", [{ msgType: "error", content: { ename: "MessageError", evalue: String(value.error ?? "declined"), traceback: [] } }])
          awaiting = undefined
        }
        return
      }
      if (message.header?.msg_type !== "execute_request") return
      const content = message.content ?? {}
      const code = String(content.code ?? "")
      executed.push({ code, allowStdin: content.allow_stdin, silent: content.silent })
      const silent = content.silent === true
      if (!silent) state.executionCount += 1
      if (code.includes(PROBE_SENTINEL)) return finish(parent, `${PROBE_SENTINEL} ${probeAnswer(code, kernel.id)}\n${probeExtraOutput}`)
      if (code.includes("_oc_watchdog_start")) {
        const seconds = Number(/_oc_watchdog_start\((\d+)\)/.exec(code)?.[1] ?? 0)
        watchdogs.push(seconds)
        return finish(parent, "")
      }
      if (code.includes("_oc_watchdog_cancel")) {
        watchdogCancels += 1
        return finish(parent, "")
      }
      if (/drive\.mount|auth\.authenticate_user|userdata\.get/.test(code)) {
        // colabtools' `send_request`: an iopub `colab_request` that blocks the cell until a stdin `colab_reply` arrives.
        const msgId = 1
        awaiting = { msgId, parent }
        send({
          ...envelope("colab_request", { request: { authType: "auth_user_ephemeral" } }, parent),
          metadata: { colab_request_type: "request_auth", colab_msg_id: msgId },
        })
        setTimeout(() => {
          if (!awaiting) return
          awaiting = undefined
          finish(parent, "", [{ msgType: "error", content: { ename: "MessageError", evalue: "the plugin did not answer", traceback: [] } }])
        }, 1_000)
        return
      }
      // A cell that never finishes, so a test can stop it with its own signal (design H4).
      if (code.includes("hang")) {
        send(envelope("stream", { name: "stdout", text: "working\n" }, parent))
        return
      }
      const scripted = [...emit.entries()].find(([fragment]) => code.includes(fragment))?.[1] ?? []
      finish(parent, code.startsWith("print(") ? "1\n" : "ok\n", [...scripted])
      // An iopub message from another request's parent, as a replay would look after a reconnect (design L6).
      if (code.includes("stale")) send(envelope("stream", { name: "stdout", text: "replayed\n" }, "stale-parent"))
    }
    socket.on("data", (chunk: Buffer) => {
      buffer = readFrames(Buffer.concat([buffer, chunk]), onText, onClose)
    })
    socket.on("error", onClose)
    socket.on("close", onClose)
  }

  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      void handle(request, response, Buffer.concat(chunks)).catch(() => {
        if (!response.headersSent) json(response, 500, { message: "fake failure" })
      })
    })
  })
  const proxy: Server = createServer((request, response) => {
    const seen: WireRecord = { method: request.method ?? "GET", path: request.url ?? "/", headers: request.headers }
    requests.push(seen)
    const supplied = request.headers["x-colab-runtime-proxy-token"]
    if (!valid || typeof supplied !== "string" || !accepted.has(supplied)) {
      response.writeHead(404, { "content-type": "application/json" })
      response.end(JSON.stringify({ message: "Not Found" }))
      return
    }
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      void handle(request, response, Buffer.concat(chunks)).catch(() => {
        if (!response.headersSent) json(response, 500, { message: "fake failure" })
      })
    })
  })
  proxy.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrades.push({ method: request.method ?? "GET", path: request.url ?? "/", headers: request.headers })
    if (!valid || !accepted.has(String(request.headers["x-colab-runtime-proxy-token"] ?? ""))) {
      socket.end("HTTP/1.1 404 Not Found\r\n\r\n")
      return
    }
    upgrade(request, socket, head)
  })
  server.on("upgrade", upgrade)

  const listen = (target: Server) =>
    new Promise<string>((resolve) => {
      target.listen(0, "127.0.0.1", () => {
        const address = target.address() as AddressInfo
        resolve(`http://127.0.0.1:${address.port}`)
      })
    })

  const [jupyterUrl, url] = await Promise.all([listen(server), listen(proxy)])
  // Seed the runtime with the usual Colab directories; the probe's own session gets its kernel lazily.
  // A stock runtime's gcloud config: present, but holding no credential (review H1).
  contents.set("content/.config/active_config", Buffer.from("default\n"))
  contents.set("content/.config/config_sentinel", Buffer.from(""))

  return {
    url,
    jupyterUrl,
    token,
    requests,
    upgrades,
    state,
    contents,
    replies,
    stdinReplies,
    interrupts,
    watchdogs,
    get watchdogCancels() {
      return watchdogCancels
    },
    executed,
    foreignSessions,
    get extraConnections() {
      return extraConnections
    },
    emit,
    chunksSeen,
    restartProbeKernel() {
      for (const kernel of kernels.values()) baselines.delete(kernel.id)
      state.executionCount = 1
    },
    replaceSessionId(sessionName: string) {
      const session = [...sessions.values()].find((entry) => entry.name === sessionName)
      if (!session) throw new Error(`no session named ${sessionName}`)
      const id = `session-${randomUUID().slice(0, 8)}`
      sessions.set(id, { ...session, id })
      sessions.delete(session.id)
      return id
    },
    get probeExtraOutput() {
      return probeExtraOutput
    },
    set probeExtraOutput(value: string) {
      probeExtraOutput = value
    },
    set extraConnections(value: number) {
      extraConnections = value
    },
    addToken(value: string) {
      accepted.add(value)
    },
    revoke(value: string) {
      accepted.delete(value)
    },
    replaceKernel(sessionName: string) {
      const session = [...sessions.values()].find((entry) => entry.name === sessionName)
      if (!session) throw new Error(`no session named ${sessionName}`)
      const kernel = newKernel()
      const next: Session = { ...session, kernelId: kernel.id }
      sessions.set(next.id, next)
      state.kernelId = kernel.id
      return kernel.id
    },
    expire() {
      valid = false
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      sockets.clear()
      await Promise.all([new Promise<void>((resolve) => proxy.close(() => resolve())), new Promise<void>((resolve) => server.close(() => resolve()))])
    },
  }
}

/** The credential file names the fake can hold, so a test names one without restating the list. */
export const FAKE_CREDENTIAL_FILES = CREDENTIAL_FILES
