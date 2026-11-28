/**
 * Package A's doubles: the host's credential store and integration editor, and a recording `fetch` for Google's
 * endpoints. No network: every response is scripted here, and a URL with no route throws.
 */
import type { AuthHost, HostConnection, HostCredential } from "../../src/provider/auth/host.js"

export class FakeAuthHost implements AuthHost {
  /** integrationID → the credential OpenCode holds, or undefined for a connection that needs a sign-in. */
  readonly credentials = new Map<string, HostCredential | undefined>()
  /** Every needs_auth report, in order. */
  readonly reports: { readonly integrationID: string; readonly message: string }[] = []
  /** Set to make `resolve` throw, as a corrupted or unreadable credential does. */
  failResolve = false
  /** Set to make `active` throw. */
  failActive = false

  async active(integrationID: string): Promise<HostConnection | undefined> {
    if (this.failActive) throw new Error("the credential store is unreadable")
    return this.credentials.has(integrationID) && this.credentials.get(integrationID) !== undefined ? { id: `cred_${integrationID}`, type: "credential" } : undefined
  }

  async resolve(connection: HostConnection): Promise<HostCredential | undefined> {
    if (this.failResolve) throw new Error("the credential could not be read")
    const id = String(connection.id ?? "").replace(/^cred_/, "")
    return this.credentials.get(id)
  }

  async report(integrationID: string, _connection: HostConnection, message: string): Promise<void> {
    this.reports.push({ integrationID, message })
  }
}

export interface RecordedMethod {
  readonly integrationID: string
  readonly method: { readonly id: string; readonly type: "oauth"; readonly label: string; readonly form: readonly Record<string, unknown>[] }
  readonly authorize: (answer: Record<string, unknown>) => Promise<unknown>
  readonly refresh: (credential: HostCredential) => Promise<HostCredential>
  readonly label?: (credential: HostCredential) => string | undefined
}

export interface RecordedCommand {
  readonly name: string
  readonly description?: string
  readonly execute: (input: { readonly sessionID: string; readonly delivery: "steer" | "queue" }) => Promise<void>
}

export interface RecordedAssert {
  readonly sessionID: string
  readonly action: string
  readonly resources: readonly string[]
  readonly metadata: Readonly<Record<string, unknown>>
}

/** The plugin context `registerAuth` uses, with what a test needs to inspect: integrations, servers, commands, asserts, messages. */
export class FakeAuthContext {
  readonly integrations = new Map<string, { name: string; method?: RecordedMethod }>()
  readonly servers = new Map<string, { name: string; integrationID: string; config: Record<string, unknown> }>()
  readonly commands = new Map<string, RecordedCommand>()
  readonly asserts: RecordedAssert[] = []
  readonly messages: { readonly sessionID: string; readonly delivery: string; readonly text: string; readonly description: string }[] = []
  /** Return false to deny the assert (as a rule or a declined ask does). */
  decide: (request: RecordedAssert) => boolean = () => true
  readonly host: FakeAuthHost

  constructor(host: FakeAuthHost = new FakeAuthHost()) {
    this.host = host
  }

  readonly mcp = {
    transform: async (callback: (draft: unknown) => void) => {
      const draft = {
        list: () => [...this.servers.entries()].map(([name, server]) => [name, server.config] as const),
        get: (name: string) => this.servers.get(name)?.config,
        set: (name: string, config: Record<string, unknown>) => {
          this.servers.set(name, { name, integrationID: name, config })
          if (!this.integrations.has(name)) this.integrations.set(name, { name: "" })
        },
        update: (name: string, update: (config: Record<string, unknown>) => void) => {
          const server = this.servers.get(name)
          if (server) update(server.config)
        },
        remove: (name: string) => void this.servers.delete(name),
      }
      callback(draft)
      return { dispose: async () => undefined }
    },
    list: async () => ({ data: [...this.servers.values()].map((server) => ({ name: server.name, integrationID: server.integrationID, status: { status: "pending" } })) }),
  }

  readonly event = {
    subscribe: (input: { readonly signal?: AbortSignal }) => ({
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<never>>((resolve) => {
              const done = () => resolve({ done: true, value: undefined as never })
              if (input.signal?.aborted) return done()
              input.signal?.addEventListener("abort", done, { once: true })
            }),
          return: async () => ({ done: true, value: undefined as never }),
        }
      },
    }),
  }

  readonly integration = {
    transform: async (callback: (draft: unknown) => void) => {
      const draft = {
        list: () => [...this.integrations.entries()].map(([id, entry]) => ({ id, name: entry.name })),
        get: (id: string) => {
          const entry = this.integrations.get(id)
          return entry ? { id, name: entry.name } : undefined
        },
        update: (id: string, update: (integration: { id: string; name: string }) => void) => {
          const entry = this.integrations.get(id) ?? { id, name: "" }
          const ref = { id, name: entry.name }
          update(ref)
          this.integrations.set(id, { ...entry, name: ref.name })
        },
        method: {
          list: (id: string) => {
            const entry = this.integrations.get(id)
            return entry?.method ? [{ id: entry.method.method.id, type: entry.method.method.type }] : []
          },
          remove: (id: string, method: { readonly id: string }) => {
            const entry = this.integrations.get(id)
            if (entry?.method?.method.id === method.id) this.integrations.set(id, { name: entry.name })
          },
          update: (input: RecordedMethod) => {
            const entry = this.integrations.get(input.integrationID) ?? { id: input.integrationID, name: "" }
            this.integrations.set(input.integrationID, { ...entry, method: input })
          },
        },
      }
      callback(draft)
      return { dispose: async () => undefined }
    },
    connection: {
      active: (id: string) => this.host.active(id),
      resolve: (connection: HostConnection) => this.host.resolve(connection),
      status: async (input: { integrationID: string; connection: HostConnection; status: { message: string } | undefined }) => {
        if (input.status) this.host.reports.push({ integrationID: input.integrationID, message: input.status.message })
      },
    },
  }

  readonly command = {
    transform: async (callback: (editor: { add: (definition: RecordedCommand) => void }) => void) => {
      callback({ add: (definition) => void this.commands.set(definition.name, definition) })
      return { dispose: async () => undefined }
    },
  }

  readonly permission = {
    assert: async (request: RecordedAssert) => {
      this.asserts.push(request)
      if (!this.decide(request)) throw new Error("denied by the test")
    },
  }

  readonly session = {
    synthetic: async (input: { sessionID: string; delivery: "steer" | "queue"; text: string; description: string }) => {
      this.messages.push(input)
    },
  }
}
