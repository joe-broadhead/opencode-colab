// Day 0's placeholders: a port or handler whose package has not landed answers NOT_IMPLEMENTED, never a guess. Each
// package replaces its own stubs; nothing outside src/<package>/ imports this file except the registry's tests.
import { ColabError } from "./domain/errors.js"

export function notImplemented(what: string): never {
  throw new ColabError("NOT_IMPLEMENTED", `${what} is declared but not built in this pre-release.`)
}

/** A port whose every method, nested ones too (`runtime.files.list`), rejects with NOT_IMPLEMENTED, naming it. */
export function stubPort<T extends object>(name: string): T {
  const member = (path: string): unknown =>
    new Proxy(async () => notImplemented(path), {
      get(_target, property) {
        if (typeof property !== "string" || property === "then") return undefined
        return member(`${path}.${property}`)
      },
    })
  return new Proxy({} as T, {
    get(_target, property) {
      if (typeof property !== "string" || property === "then") return undefined
      return member(`${name}.${property}`)
    },
  })
}
