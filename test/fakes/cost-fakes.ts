/**
 * Package F's own doubles, built on Day 0's (test/fakes/index.ts) as the ownership table says: a Jupyter contents tree
 * that lists one level at a time (directories included, as `/api/contents` does), a runtime protocol with it, and
 * recorders for the host surfaces F uses (posted text and permission asserts).
 *
 * Shapes are Jupyter Server's REST API (https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html,
 * design §18 [19]): `/api/contents/<path>` answers one entry for a file or a directory's immediate children, with
 * `type` "directory" | "file" | "notebook" and `path` absolute without the leading slash on the wire; the plugin's port
 * keeps the leading slash.
 */
import { FakeRuntimeProtocol } from "./index.js"
import { ColabError } from "../../src/domain/errors.js"
import type { ContentEntry } from "../../src/ports.js"

/** A contents tree: a file's bytes by absolute runtime path, and the directories that hold them. */
export class CostContents {
  readonly files = new Map<string, Uint8Array>()
  readonly directories = new Set<string>()
  /** Paths whose read fails with this code. */
  readonly failing = new Map<string, "NOT_FOUND" | "UNAVAILABLE">()
  /** Every read the plugin made, in order. */
  readonly reads: string[] = []

  put(path: string, text: string): void {
    this.files.set(path, new TextEncoder().encode(text))
    const parts = path.split("/").filter((part) => part !== "")
    for (let index = 1; index < parts.length; index++) this.directories.add(`/${parts.slice(0, index).join("/")}`)
  }

  /** One level, as `/api/contents` lists it; `undefined` when the path holds nothing. */
  list(path: string): readonly ContentEntry[] | undefined {
    const base = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path
    const file = this.files.get(base)
    if (file !== undefined) return [{ path: base, type: "file", size: file.length }]
    const prefix = base === "/" ? "/" : `${base}/`
    const children: ContentEntry[] = []
    for (const directory of this.directories) {
      if (directory.startsWith(prefix) && !directory.slice(prefix.length).includes("/")) children.push({ path: directory, type: "directory" })
    }
    for (const [filePath, bytes] of this.files) {
      if (filePath.startsWith(prefix) && !filePath.slice(prefix.length).includes("/")) children.push({ path: filePath, type: "file", size: bytes.length })
    }
    return children.length === 0 ? undefined : children
  }

  read(path: string): Uint8Array {
    this.reads.push(path)
    const failure = this.failing.get(path)
    if (failure !== undefined) throw new ColabError(failure)
    const bytes = this.files.get(path)
    if (bytes === undefined) throw new ColabError("NOT_FOUND")
    return bytes
  }
}

/** A runtime protocol whose `files` is the contents tree above; kernels and sessions are Day 0's settable maps. */
export class CostRuntime extends FakeRuntimeProtocol {
  constructor(readonly tree = new CostContents()) {
    super()
    const files = this.files as unknown as Record<string, unknown>
    files.list = async (_target: unknown, path: string) => tree.list(path)
    files.read = async (_target: unknown, path: string) => {
      const bytes = tree.read(path)
      return (async function* () {
        yield bytes
      })()
    }
    files.write = async () => {
      throw new ColabError("NOT_IMPLEMENTED", "The cost tests do not write to a runtime.")
    }
  }
}

/** Records `ctx.session.synthetic` calls, as `/colab-cleanup` posts them. */
export class RecordingSynthetic {
  readonly posts: { readonly text: string; readonly description?: string; readonly metadata?: Record<string, unknown> }[] = []

  readonly synthetic = async (input: { readonly text: string; readonly description?: string; readonly metadata?: Record<string, unknown> }) => {
    this.posts.push({ text: input.text, ...(input.description !== undefined ? { description: input.description } : {}), ...(input.metadata !== undefined ? { metadata: input.metadata } : {}) })
  }
}

export type RecordedAssert = {
  readonly sessionID?: string
  readonly action: string
  readonly resources?: readonly string[]
  readonly metadata?: Readonly<Record<string, unknown>>
  readonly source?: unknown
}

/** Records every `ctx.permission.assert`, and can deny one. */
export class RecordingAsserts {
  readonly requests: RecordedAssert[] = []
  deny: (request: RecordedAssert) => boolean = () => false

  readonly assert = async (request: RecordedAssert) => {
    this.requests.push(request)
    if (this.deny(request)) throw new Error("the prompt was declined")
  }
}
