// Day 0's placeholders: a port or handler whose package has not landed answers NOT_IMPLEMENTED, never a guess. Each
// package replaces its own stubs; nothing outside src/<package>/ imports this file except the registry's tests.
import { ColabError } from "./domain/errors.js"
import type { Budget, Prices } from "./ports.js"

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

/** Day 0's Budget until package F exports `createBudget`: no budget is set, so every check is `ok`. */
export const OK_BUDGET: Budget = { check: async () => ({ verdict: "ok" }) }

/** Day 0's Prices until package E's `createEnterprisePorts` returns `prices`: nothing is priced. */
export const NO_PRICES: Prices = { asOf: "", source: "", region: "us-central1", usdPerHour: () => undefined }
