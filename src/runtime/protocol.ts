/**
 * The runtime protocol: Jupyter Server's REST API and the kernel WebSocket on one runtime, through
 * `connectionInfo.url` with the `X-Colab-Runtime-Proxy-Token` header (design §1, §7.4, H6).
 *
 * Three rules live here, so no caller can skip them:
 *
 * 1. **Ours only.** Every call checks the ledger first: a runtime with no record of the plugin's own, a record for
 *    another account, a released record, or a tainted one is refused before any network call (`RUNTIME_NOT_OURS`,
 *    `RUNTIME_GONE`, or the taint's code). Code therefore cannot run, list or move files on a runtime the person or
 *    another client uses; this is the transport half of the guarantee, and package D's tools sit on top of it.
 * 2. **Credentials stay in memory.** The URL and token go through `checkConnection` before use and are never put in a
 *    message, a result or an error.
 * 3. **No interactive credential flow.** Every `execute_request` carries `allow_stdin: false`, and every `colab_request`
 *    is answered in the same tick with an `input_reply` on the stdin channel whose `content.value` is the
 *    `colab_reply` colab-vscode sends when a person declines (design §7.4 step 5, L9).
 *
 * Shapes: Jupyter Server's REST API (https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html) and the
 * messaging protocol (https://jupyter-client.readthedocs.io/en/stable/messaging.html), as design §18 [19] records them;
 * the kernel channel path and the `colab_request`/`colab_reply` pair as design §18 [3] and [4] show them.
 */
import { randomUUID } from "node:crypto"
import { ColabError } from "../domain/errors.js"
import type { PortEnv } from "../deps.js"
import type { ColabApi, ContentEntry, ExecuteOptions, IopubMessage, KernelInfo, KernelSession, RuntimeProtocol, RuntimeTarget, SessionInfo } from "../ports.js"
import { JUPYTER_PATHS } from "./discovery.js"
import { checkConnection, runtimePath, runtimeUrl, type CheckedConnection } from "./url.js"
import { connectTextSocket, type TextSocket } from "./websocket.js"
import { cancelWatchdog, startWatchdog } from "./watchdog.js"

/** The kernel the plugin asks for: Python is the only kernel v0.1.0 supports (design §3, non-goals). */
const KERNEL_NAME = "python3"
/** Refreshed five minutes before `expireTime` (design §7.4). */
const REFRESH_SKEW_MS = 5 * 60_000
/** Jupyter accepts one contents write of up to 50 MB (design §9.3). */
const MAX_CONTENTS_BYTES = 50 * 1024 * 1024
const USERNAME = "opencode-colab"

/** What package B's own code (the agent-only check) needs and the port does not expose. */
export interface RuntimeProtocolInternal extends RuntimeProtocol {
  /** Kernel ids this process holds a socket to on the runtime: the plugin's own connections, for the check's baseline. */
  attachedKernels(runtimeId: string): readonly string[]
}

interface WireMessage {
  readonly header?: { readonly msg_id?: string; readonly msg_type?: string }
  readonly parent_header?: { readonly msg_id?: string }
  readonly metadata?: { readonly colab_msg_id?: number }
  readonly content?: Record<string, unknown>
  readonly channel?: string
}

const parse = (text: string): WireMessage | undefined => {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === "object" ? (value as WireMessage) : undefined
  } catch {
    return undefined
  }
}

/** A Jupyter REST answer that failed, as a code; 401/403/404 on the proxy usually mean the token expired (design §1). */
const httpError = (status: number) => new ColabError(status === 404 ? "NOT_FOUND" : status === 401 || status === 403 ? "AUTH_REQUIRED" : "UNAVAILABLE")

export interface RuntimeProtocolOptions {
  readonly connectTimeoutMs?: number
  readonly now?: () => number
  /** Test-only: lets the loopback fakes' plain-http 127.0.0.1 origin stand in for a runtime. */
  readonly allowLoopback?: boolean
}

export function createRuntimeProtocol(env: PortEnv, api: ColabApi, overrides: RuntimeProtocolOptions = {}): RuntimeProtocolInternal {
  const now = overrides.now ?? (() => env.clock.now().getTime())
  const connections = new Map<string, CheckedConnection & { readonly at: number }>()
  const attached = new Map<string, Set<string>>()
  /** One handle per (runtime, session name): a second `openSession` for the same name reuses it. */
  const handles = new Map<string, KernelSession>()
  const cacheKey = (target: RuntimeTarget) => `${target.account}/${target.runtimeId}`

  /** Rule 1: the runtime is in the ledger as the plugin's own, for this account, ready and untainted. */
  const assertOurs = async (target: RuntimeTarget) => {
    const ours = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(target.runtimeId) ? await env.ledger.getRuntime(target.runtimeId) : undefined
    if (!ours || ours.account !== target.account) throw new ColabError("RUNTIME_NOT_OURS")
    if (ours.tainted) throw new ColabError(ours.tainted.code)
    if (ours.state === "released" || ours.state === "gone") throw new ColabError("RUNTIME_GONE")
    // "creating" is allowed: the create's LRO may still be settling while the runtime is checked for the first time.
    if (ours.state !== "ready" && ours.state !== "creating") throw new ColabError("RUNTIME_NOT_OURS")
  }

  const connection = async (target: RuntimeTarget, signal: AbortSignal, refresh = false): Promise<CheckedConnection> => {
    const key = cacheKey(target)
    const cached = connections.get(key)
    if (!refresh && cached && (cached.expireTime === undefined || now() < cached.expireTime - REFRESH_SKEW_MS)) return cached
    const answer = await api.getRuntime(target.account, target.runtimeId, signal)
    if (!answer?.connection) throw new ColabError("RUNTIME_UNVERIFIED", "The runtime answered without usable connection information.")
    const checked = checkConnection(answer.connection, { allowLoopback: overrides.allowLoopback === true })
    connections.set(key, { ...checked, at: now() })
    return checked
  }

  const socketHeaders = (checked: CheckedConnection) => ({ "X-Colab-Runtime-Proxy-Token": checked.token, accept: "application/json" })

  /** One REST call against the runtime, refreshing an expired proxy token once (design §1: 404 on an expired token). */
  const rest = async (target: RuntimeTarget, request: { readonly method: string; readonly path: string; readonly body?: unknown; readonly headers?: Readonly<Record<string, string>> }, signal: AbortSignal, retried = false): Promise<Response> => {
    const checked = await connection(target, signal)
    const url = runtimeUrl(checked.url, request.path)
    let response: Response
    try {
      response = await env.fetch(url, {
        method: request.method,
        headers: {
          ...socketHeaders(checked),
          ...(request.body !== undefined ? { "content-type": "application/json" } : {}),
          ...request.headers,
        },
        ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
        signal,
        redirect: "error",
      })
    } catch (error) {
      if (signal.aborted) throw new ColabError("CANCELLED")
      if (error instanceof ColabError) throw error
      throw new ColabError("UNAVAILABLE")
    }
    // The proxy answers 404 for an expired token (design §1), so one refresh-and-retry covers 401, 403 and 404; a real
    // 404 then costs one extra `runtimes.get`, which is cheaper than a wrong refusal.
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      if (!retried) {
        await connection(target, signal, true)
        return rest(target, request, signal, true)
      }
      throw httpError(response.status)
    }
    if (!response.ok) throw httpError(response.status)
    return response
  }

  const restJson = async (target: RuntimeTarget, request: { readonly method: string; readonly path: string; readonly body?: unknown }, signal: AbortSignal): Promise<Record<string, unknown> | undefined> => {
    const response = await rest(target, request, signal)
    const text = await response.text().catch(() => "")
    if (text === "") return undefined
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new ColabError("UNAVAILABLE")
    }
  }

  const sessions = async (target: RuntimeTarget, signal: AbortSignal): Promise<readonly SessionInfo[]> => {
    const body = await restJson(target, { method: "GET", path: JUPYTER_PATHS.sessions }, signal)
    const list = (body?.sessions ?? body) as { id?: string; name?: string; path?: string; kernel?: { id?: string } }[] | undefined
    if (!Array.isArray(list)) return []
    return list.map((entry) => ({ id: entry.id ?? "", name: entry.name ?? "", path: entry.path ?? "", kernelId: entry.kernel?.id ?? "" }))
  }

  const kernels = async (target: RuntimeTarget, signal: AbortSignal): Promise<readonly KernelInfo[]> => {
    const body = await restJson(target, { method: "GET", path: JUPYTER_PATHS.kernels }, signal)
    const list = (body?.kernels ?? body) as { id?: string; name?: string; execution_state?: string; last_activity?: string; connections?: number }[] | undefined
    if (!Array.isArray(list)) return []
    return list.map((entry) => ({
      id: entry.id ?? "",
      name: entry.name ?? "",
      executionState: entry.execution_state ?? "unknown",
      lastActivity: entry.last_activity ?? "",
      connections: typeof entry.connections === "number" ? entry.connections : 0,
    }))
  }

  const kernelSocket = async (target: RuntimeTarget, checked: CheckedConnection, session: SessionInfo, signal: AbortSignal) => {
    const url = runtimeUrl(checked.url, `${JUPYTER_PATHS.kernels}/${encodeURIComponent(session.kernelId)}/channels?session_id=${encodeURIComponent(session.id)}`)
    const socket = await connectTextSocket({ url: url.href, headers: socketHeaders(checked), signal, connectTimeoutMs: overrides.connectTimeoutMs })
    const set = attached.get(target.runtimeId) ?? new Set<string>()
    set.add(session.kernelId)
    attached.set(target.runtimeId, set)
    return socket
  }

  /** The Jupyter message envelope, as every frontend sends it. */
  const envelope = (sessionId: string, msgType: string, content: Record<string, unknown>, parentHeader: Record<string, unknown> = {}, version = "5.3") => ({
    header: { msg_id: randomUUID(), username: USERNAME, session: sessionId, date: new Date().toISOString(), msg_type: msgType, version },
    parent_header: parentHeader,
    metadata: {},
    content,
    channel: msgType === "input_reply" ? "stdin" : "shell",
    buffers: [] as never[],
  })

  /** The decline colab-vscode sends: an `input_reply` on stdin whose `content.value` is a `colab_reply` (design §7.4). */
  const decline = (socket: TextSocket, sessionId: string, message: WireMessage) => {
    socket.send(
      JSON.stringify(
        envelope(
          sessionId,
          "input_reply",
          { value: { type: "colab_reply", colab_msg_id: message.metadata?.colab_msg_id ?? 0, error: "not available in opencode-colab" } },
          {},
          "5.0",
        ),
      ),
    )
  }

  const kernelSession = (target: RuntimeTarget, session: SessionInfo, socket: TextSocket): KernelSession => {
    const execute = async function* (code: string, options: ExecuteOptions, signal: AbortSignal): AsyncGenerator<IopubMessage> {
      const messageId = randomUUID()
      const request = envelope(session.id, "execute_request", {
        code,
        silent: options.silent,
        store_history: options.storeHistory,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      })
      socket.send(JSON.stringify({ ...request, header: { ...request.header, msg_id: messageId } }))
      // The socket was opened under another signal, so this call's own signal is raced here: a Stop ends the stream
      // even while the kernel is quiet (design H4).
      const frames = socket.messages()[Symbol.asyncIterator]()
      const aborted = new Promise<never>((_, reject) => {
        const fail = () => reject(new ColabError("CANCELLED"))
        if (signal.aborted) return fail()
        signal.addEventListener("abort", fail, { once: true })
      })
      aborted.catch(() => undefined)
      for (;;) {
        const next = await Promise.race([frames.next(), aborted])
        if (next.done) break
        const text = next.value
        const message = parse(text)
        if (!message || message.parent_header?.msg_id !== messageId) continue
        const msgType = message.header?.msg_type ?? ""
        if (message.channel !== "iopub") continue
        // Declined in the same tick, and still yielded so capture can report COLAB_UI_API.
        if (msgType === "colab_request") decline(socket, session.id, message)
        yield { parentMsgId: messageId, msgType, content: message.content ?? {} }
        if (msgType === "status" && message.content?.execution_state === "idle") return
      }
      if (signal.aborted) throw new ColabError("CANCELLED")
      throw new ColabError("KERNEL_DIED")
    }

    return {
      session,
      execute,
      async interrupt(signal: AbortSignal) {
        await rest(target, { method: "POST", path: `${JUPYTER_PATHS.kernels}/${encodeURIComponent(session.kernelId)}/interrupt` }, signal)
      },
      async restart(signal: AbortSignal) {
        await rest(target, { method: "POST", path: `${JUPYTER_PATHS.kernels}/${encodeURIComponent(session.kernelId)}/restart` }, signal)
      },
      async close() {
        socket.close()
        attached.get(target.runtimeId)?.delete(session.kernelId)
      },
    }
  }

  const protocol: RuntimeProtocolInternal = {
    async openSession(target, input, signal) {
      await assertOurs(target)
      const handleKey = `${cacheKey(target)}/${input.name}`
      const reused = handles.get(handleKey)
      if (reused) return reused
      const checked = await connection(target, signal)
      const existing = (await sessions(target, signal)).find((entry) => entry.name === input.name)
      const session: SessionInfo =
        existing ??
        (await restJson(target, { method: "POST", path: JUPYTER_PATHS.sessions, body: { path: runtimePath(input.path), name: input.name, type: "notebook", kernel: { name: KERNEL_NAME } } }, signal).then((body) => {
          const created = body as { id?: string; path?: string; name?: string; kernel?: { id?: string } } | undefined
          if (!created?.id || !created.kernel?.id) throw new ColabError("KERNEL_DIED", "The runtime answered the session request without a kernel.")
          return { id: created.id, name: created.name ?? input.name, path: created.path ?? input.path, kernelId: created.kernel.id }
        }))
      const socket = await kernelSocket(target, checked, session, signal)
      const created = kernelSession(target, session, socket)
      // Additive: the run's watchdog lives in this package (design §8.2); package D calls it when it is present.
      const handle = Object.assign(created, {
        watchdog: async (seconds: number | null, watchdogSignal: AbortSignal) => {
          if (seconds === null) await cancelWatchdog(created, watchdogSignal)
          else await startWatchdog(created, seconds, watchdogSignal)
        },
        close: async () => {
          handles.delete(handleKey)
          attached.get(target.runtimeId)?.delete(session.kernelId)
          socket.close()
        },
      })
      handles.set(handleKey, handle)
      return handle
    },

    async kernels(target, signal) {
      await assertOurs(target)
      return kernels(target, signal)
    },

    async sessions(target, signal) {
      await assertOurs(target)
      return sessions(target, signal)
    },

    files: {
      async list(target, path, signal) {
        await assertOurs(target)
        let body: Record<string, unknown> | undefined
        try {
          body = await restJson(target, { method: "GET", path: `${JUPYTER_PATHS.contents}/${encodePath(path)}` }, signal)
        } catch (error) {
          if (error instanceof ColabError && error.code === "NOT_FOUND") return undefined
          throw error
        }
        if (!body) return []
        const type = String(body.type ?? "")
        if (type === "directory" || Array.isArray(body.content)) {
          const entries = (body.content ?? []) as { name?: string; path?: string; type?: string; size?: number; last_modified?: string }[]
          const base = runtimePath(path)
          return entries.map((entry) => ({
            path: entry.path ?? `${base}/${entry.name ?? ""}`,
            type: entry.type === "directory" ? "directory" : entry.type === "notebook" ? "notebook" : "file",
            ...(typeof entry.size === "number" ? { size: entry.size } : {}),
            ...(entry.last_modified ? { lastModified: entry.last_modified } : {}),
          })) satisfies ContentEntry[]
        }
        return [{ path: runtimePath(path), type: type === "notebook" ? "notebook" : "file", ...(typeof body.size === "number" ? { size: body.size as number } : {}) }]
      },

      async read(target, path, signal) {
        await assertOurs(target)
        const response = await rest(target, { method: "GET", path: `${JUPYTER_PATHS.files}/${encodePath(path)}`, headers: { range: "bytes=0-" } }, signal)
        const body = response.body
        if (!body) throw new ColabError("NOT_FOUND")
        return (async function* () {
          for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) yield chunk
        })()
      },

      async write(target, path, bytes, signal) {
        await assertOurs(target)
        const parts: Uint8Array[] = []
        let total = 0
        for await (const chunk of bytes) {
          total += chunk.byteLength
          if (total > MAX_CONTENTS_BYTES) throw new ColabError("FILE_TOO_LARGE", "The file is larger than the 50 MB a Jupyter contents write accepts.")
          parts.push(chunk)
        }
        const buffer = parts.length === 1 ? parts[0]! : Buffer.concat(parts)
        await rest(
          target,
          { method: "PUT", path: `${JUPYTER_PATHS.contents}/${encodePath(path)}`, body: { type: "file", format: "base64", content: Buffer.from(buffer).toString("base64") } },
          signal,
        )
        return { bytes: total }
      },
    },

    attachedKernels(runtimeId: string) {
      return [...(attached.get(runtimeId) ?? [])]
    },
  }

  return protocol
}

/** A runtime path as a REST path segment list: every segment encoded, none dropped. */
function encodePath(path: string): string {
  return runtimePath(path)
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}
