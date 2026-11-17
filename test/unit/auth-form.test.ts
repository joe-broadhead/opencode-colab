// §15.1 auth and H10's form: the fields, the levels, the exact scopes each level shows, the acknowledgment, the host's
// hidden fields, and how an answer is read.
import { describe, expect, it } from "vitest"
import { loadOptions, resolveAccount } from "../../src/options.js"
import { readAnswer, signInForm, signInRedirect, type FormField, type FormOption, type SignInForm } from "../../src/auth/form.js"
import { SCOPES } from "../../src/auth/scopes.js"

const account = (raw: unknown, alias: string) => resolveAccount(loadOptions(raw), alias)
const field = (form: SignInForm, key: string): FormField => form.find((entry) => entry.key === key)!

describe("the sign-in form (design §4)", () => {
  it("§15.1 auth — the default consumer account shows both levels and each option lists its exact scope URLs", () => {
    const form = signInForm("default", account({}, "default"), undefined)
    const access = field(form, "access")
    expect(access.default).toBe("write")
    const options = access.options as readonly FormOption[]
    expect(options.map((option) => option.value)).toEqual(["read", "write"])
    expect(options[0]!.description).toContain(`${SCOPES.openid} ${SCOPES.email} ${SCOPES.colaboratoryReadonly} ${SCOPES.driveFile}`)
    expect(options[1]!.description).toContain(`${SCOPES.openid} ${SCOPES.email} ${SCOPES.colaboratory} ${SCOPES.driveFile}`)
    expect(String(field(form, "access").description)).toContain("your own Colab")
    expect(field(form, "confirmWrite").when).toEqual([{ key: "access", op: "eq", value: "write" }])
    expect(field(form, "clientJson").hidden).toBe(true)
    expect(field(form, "redirectUri").hidden).toBe(true)
    expect(field(form, "callbackPort").hidden).toBe(true)
  })

  it("§15.1 auth — a read account does not offer write, so the config's access is the fence", () => {
    const home = account({ accounts: { home: {} } }, "home")
    const form = signInForm("home", home, undefined)
    const options = field(form, "access").options as readonly FormOption[]
    expect(options.map((option) => option.value)).toEqual(["read"])
    expect(form.some((entry) => entry.key === "confirmWrite")).toBe(false)
  })

  it("§15.1 auth — an Enterprise account shows both levels, the same scopes, and no write acknowledgment", () => {
    const work = account({ accounts: { work: { backend: "enterprise", access: "write", project: "p", region: "us-central1" } } }, "work")
    const form = signInForm("work", work, undefined)
    const options = field(form, "access").options as readonly FormOption[]
    expect(options).toHaveLength(2)
    expect(options[0]!.description).toContain(SCOPES.cloudPlatform)
    expect(options[1]!.description).toBe(options[0]!.description)
    expect(form.some((entry) => entry.key === "confirmWrite")).toBe(false)
    expect(String(field(form, "access").description)).toContain("Colab Enterprise")
    expect(String(field(form, "access").description)).toContain("no read-only scope")
  })

  it("§15.1 auth — a configured client hides both client fields and puts no secret in the form", () => {
    const form = signInForm("default", account({}, "default"), { client: { clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-top-secret" }, source: "plugin" })
    expect(field(form, "clientId").hidden).toBe(true)
    expect(field(form, "clientSecret").hidden).toBe(true)
    expect(field(form, "clientId").default).toBeUndefined()
    expect(JSON.stringify(form)).not.toContain("GOCSPX-top-secret")
  })

  it("§15.1 auth — a half-entered client, an unacknowledged write and a redirect without its port are refused before any call", () => {
    const home = account({ accounts: { home: { access: "write" } } }, "home")
    expect(() => readAnswer({ clientId: "123456789012-abc.apps.googleusercontent.com" }, home)).toThrow(/^INPUT_INVALID: /)
    expect(() => readAnswer({ access: "write", confirmWrite: false }, home)).toThrow(/^INPUT_INVALID: Write access was chosen without the acknowledgment/)
    expect(() => readAnswer({ access: "write" }, home)).toThrow(/^INPUT_INVALID: /)
    const readOnly = account({ accounts: { read: {} } }, "read")
    expect(() => readAnswer({ access: "write" }, readOnly)).toThrow(/^INPUT_INVALID: The account read is configured read-only/)
    expect(() => readAnswer({ redirectUri: "http://host.example/oauth/return" }, home)).toThrow(/^INPUT_INVALID: The sign-in redirect must use https/)
    expect(() => readAnswer({ callbackPort: 70000 }, home)).toThrow(/^INPUT_INVALID: The sign-in callbackPort/)
    const answered = readAnswer({ access: "write", confirmWrite: true, redirectUri: "https://host.example/oauth/return" }, home)
    expect(() => signInRedirect(answered.redirect, {})).toThrow(/^INPUT_INVALID: .*without callbackPort/)
    expect(signInRedirect(answered.redirect, { callbackPort: 8080 })).toMatchObject({ uri: "https://host.example/oauth/return", port: 8080 })
  })

  it("§15.1 auth — an answer's client and level are read, and the host's redirect wins over its option", () => {
    const home = account({ accounts: { home: { access: "write" } } }, "home")
    const answer = readAnswer(
      {
        clientJson: JSON.stringify({ installed: { client_id: "123456789012-abc.apps.googleusercontent.com", client_secret: "GOCSPX-secret" } }),
        access: "read",
        redirectUri: "https://host.example/oauth/return",
        callbackPort: "8080",
      },
      home,
    )
    expect(answer.pasted).toEqual({ clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-secret" })
    expect(answer.access).toBe("read")
    expect(signInRedirect(answer.redirect, { redirectUri: "https://other.example/return", callbackPort: 9000 })).toEqual({ uri: "https://host.example/oauth/return", port: 8080, paths: ["/oauth/return"] })
    expect(signInRedirect({}, {})).toEqual({ uri: "", port: 0, paths: ["/", "/callback"] })
    expect(signInRedirect({}, { callbackPort: 7777 })).toEqual({ uri: "http://127.0.0.1:7777", port: 7777, paths: ["/", "/callback"] })
  })
})
