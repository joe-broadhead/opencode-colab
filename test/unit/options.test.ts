import { describe, expect, it } from "vitest"
import { loadOptions, resolveAccount } from "../../src/options.js"

describe("options", () => {
  it("default to design §13's values and one default account, backend colab, interactive, read and write", () => {
    const options = loadOptions(undefined)
    expect(options).toMatchObject({
      access: "all",
      accelerators: ["NONE", "T4", "L4"],
      maxRuntimes: 1,
      keep: ["/content/outputs/**"],
      autoReleaseMinutes: 20,
      maxRuntimeHours: 4,
      enterpriseMachine: "e2-standard-4",
      jobTimeoutMinutes: 60,
      maxJobUsd: 5,
      maxJobUsdCeiling: 50,
      automation: "auto",
      maxInlineBytes: 32 * 1024,
      maxOutputBytesPerCell: 1024 * 1024,
      maxRunSeconds: 21_600,
      maxUploadBytes: 512 * 1024 ** 2,
      maxDownloadBytes: 2 * 1024 ** 3,
      allowSecretUpload: false,
      pushOutputs: "strip",
      workDir: ".colab",
      ledgerDays: 90,
      planTtlSeconds: 300,
      provisioningMarginMinutes: 10,
      probeTimeoutSeconds: 5,
      probeKernelStartSeconds: 60,
      allowUntestedHost: false,
    })
    expect(options.accounts).toEqual([{ alias: "default", backend: "colab", mode: "interactive", access: "write", drive: true, runAsUser: false }])
  })

  it("gives a named account read access and an enterprise account no Drive, unless set", () => {
    const options = loadOptions({ accounts: { work: { backend: "enterprise", project: "p", region: "us-central1" }, default: {} } })
    expect(options.accounts.find((account) => account.alias === "work")).toMatchObject({ access: "read", drive: false, backend: "enterprise" })
    expect(resolveAccount(options, undefined).alias).toBe("default")
    expect(resolveAccount(options, "work").alias).toBe("work")
  })

  it("refuses unknown options, ADC on a colab account, a cap over its ceiling, and an unnamed call among several accounts", () => {
    expect(() => loadOptions({ acess: "all" })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "acess": this option does not exist/)
    expect(() => loadOptions({ accounts: { home: { mode: "adc" } } })).toThrow(/^OPTIONS_INVALID: .*adc is for enterprise/)
    expect(() => loadOptions({ maxJobUsd: 60 })).toThrow(/^OPTIONS_INVALID: .*maxJobUsdCeiling/)
    expect(() => loadOptions({ accounts: { home: { token: "x" } } })).toThrow(/^OPTIONS_INVALID: Invalid plugin option "accounts.home.token"/)
    const two = loadOptions({ accounts: { home: {}, work: { backend: "enterprise" } } })
    expect(() => resolveAccount(two, undefined)).toThrow(/^ACCOUNT_REQUIRED: /)
    expect(() => resolveAccount(two, "nope")).toThrow(/^ACCOUNT_UNKNOWN: /)
  })

  it("reads sizes as KiB, MiB and GiB", () => {
    expect(loadOptions({ maxInlineBytes: "64KiB" }).maxInlineBytes).toBe(65_536)
    expect(() => loadOptions({ maxInlineBytes: "64KB" })).toThrow(/^OPTIONS_INVALID: /)
  })
})
