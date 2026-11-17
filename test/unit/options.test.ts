import { describe, expect, it } from "vitest"
import { loadOptions } from "../../src/options.js"

describe("options", () => {
  it("default to access all", () => {
    expect(loadOptions(undefined)).toEqual({ access: "all", allowUntestedHost: false })
  })

  it("refuse an unknown option and an unknown access", () => {
    expect(() => loadOptions({ acess: "all" })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "acess": this option does not exist/)
    expect(() => loadOptions({ access: "write" })).toThrow(/^OPTIONS_INVALID: /)
  })
})
