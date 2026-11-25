import { describe, expect, test } from "vitest"
import * as z from "zod"
import { loadOptions } from "../../src/options.js"
import { PROFILE_SCHEMA } from "../../src/accounts.js"
import { ColabError } from "../../src/domain/errors.js"

describe("options", () => {
  test("with no options: one default write account and the product defaults", () => {
    const options = loadOptions({})
    expect(options.access).toBe("all")
    expect(options.accounts).toEqual([
      expect.objectContaining({ alias: "default", backend: "colab", mode: "interactive", access: "write" }),
    ])
    expect(options.maxRuntimes).toBe(1)
    expect(options.autoReleaseMinutes).toBe(20)
  })

  test("a named account defaults to read and keeps its profile", () => {
    const options = loadOptions({ accounts: { work: { backend: "enterprise", project: "p", region: "us-central1" } }, access: "ask-changes" })
    expect(options.access).toBe("ask-changes")
    expect(options.accounts[0]).toMatchObject({ alias: "work", backend: "enterprise", access: "read", project: "p", region: "us-central1" })
  })

  test("an unknown option is OPTIONS_INVALID, not ignored", () => {
    try {
      loadOptions({ typo: true })
      expect.unreachable("the option should be refused")
    } catch (error) {
      expect(error).toBeInstanceOf(ColabError)
      expect((error as ColabError).code).toBe("OPTIONS_INVALID")
    }
  })

  test("the profile schema accepts every optional field and refuses an unknown one or a bad enum", () => {
    const profile = z.fromJSONSchema(PROFILE_SCHEMA as never)
    expect(profile.safeParse({}).success).toBe(true)
    expect(profile.safeParse({ backend: "enterprise", project: "p", budget: { action: "refuse" } }).success).toBe(true)
    expect(profile.safeParse({ backend: "other" }).success).toBe(false)
    expect(profile.safeParse({ notAField: true }).success).toBe(false)
  })
})
