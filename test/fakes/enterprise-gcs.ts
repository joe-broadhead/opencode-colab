/**
 * Package E's Cloud Storage fake: Day 0's `FakeGcs` (test/fakes/index.ts) plus the object timestamps a job's result
 * capture filters on, and a helper that stores a notebook object the way a finished run leaves one in the bucket.
 *
 * Cloud Storage JSON API v1 object shape (`name`, `size`, `updated`), fetched 2026-11-17:
 * https://cloud.google.com/storage/docs/json_api/v1/objects/list — no network, no Google call.
 */
import { FakeGcs } from "./index.js"

export class ScriptedGcs extends FakeGcs {
  readonly updated = new Map<string, string>()

  /** Store an object with the `updated` time Google would report. */
  put(uri: string, bytes: Uint8Array, updated = new Date().toISOString()) {
    this.objects.set(uri, bytes)
    this.updated.set(uri, updated)
  }

  /** Store an output notebook as a finished run writes it. */
  putNotebook(uri: string, notebook: unknown, updated = new Date().toISOString()) {
    this.put(uri, new Uint8Array(Buffer.from(JSON.stringify(notebook), "utf8")), updated)
  }

  override async list(account: string, prefix: string) {
    const items = await super.list(account, prefix)
    return items.map((item) => ({ ...item, ...(this.updated.has(item.uri) ? { updated: this.updated.get(item.uri)! } : {}) }))
  }
}
