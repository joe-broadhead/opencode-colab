// §15.1 auth: the OAuth client's precedence, the shapes Google's client JSON and option carry, and the redirect a
// client would make Google refuse (checked before anything listens).
import { describe, expect, it } from "vitest"
import { clientFromJson, clientFromOption, desktopClient, isClientId, redirectMismatch, resolveClient, type OAuthClient } from "../../src/provider/auth/client.js"
import { invented } from "../support/invented.js"

const desktop: OAuthClient = { clientId: "123456789012-abc.apps.googleusercontent.com", clientSecret: invented("GOCSPX-", "secret") }
const web: OAuthClient = { ...desktop, redirectUris: ["https://host.example/oauth/return"] }

describe("the OAuth client (design §4)", () => {
  it("§15.1 auth — precedence is the account, the plugin, the form, then a previously pasted client", () => {
    expect(resolveClient({ account: desktop, plugin: web, pasted: web })).toEqual({ client: desktop, source: "account" })
    expect(resolveClient({ plugin: web, pasted: desktop })).toEqual({ client: web, source: "plugin" })
    expect(resolveClient({ pasted: desktop, previous: { client: web, source: "plugin" } })).toEqual({ client: desktop, source: "pasted" })
    expect(resolveClient({ previous: { client: desktop, source: "pasted" } })).toEqual({ client: desktop, source: "pasted" })
    expect(resolveClient({ previous: { client: desktop, source: "plugin" } })).toBeUndefined()
    expect(resolveClient({})).toBeUndefined()
  })

  it("§15.1 auth — a Desktop client's ID and secret are checked, and a malformed pair is refused", () => {
    expect(isClientId(desktop.clientId)).toBe(true)
    expect(desktopClient("123456789012-abc.apps.googleusercontent.com", invented("GOCSPX-", "secret"))).toEqual(desktop)
    expect(desktopClient("not-a-client", invented("GOCSPX-", "secret"))).toBeUndefined()
    expect(desktopClient(desktop.clientId, "bad secret!")).toBeUndefined()
  })

  it("§15.1 auth — Google's downloaded client JSON is read as installed or web, and anything else is refused", () => {
    expect(clientFromJson(JSON.stringify({ installed: { client_id: desktop.clientId, client_secret: desktop.clientSecret, project_id: "p" } }))).toEqual(desktop)
    expect(clientFromJson(JSON.stringify({ web: { client_id: desktop.clientId, client_secret: desktop.clientSecret, redirect_uris: ["https://host.example/oauth/return"] } }))).toEqual(web)
    expect(clientFromJson("{not json")).toBeUndefined()
    expect(clientFromJson(JSON.stringify({ installed: { client_id: "nope", client_secret: "x" } }))).toBeUndefined()
    expect(clientFromJson(JSON.stringify({ web: { client_id: desktop.clientId, client_secret: desktop.clientSecret } }))).toEqual({ ...desktop, redirectUris: [] })
  })

  it("§15.1 auth — the oauthClient option reads as JSON or as <clientId>:<clientSecret>", () => {
    expect(clientFromOption(`${desktop.clientId}:${desktop.clientSecret}`)).toEqual(desktop)
    expect(clientFromOption(JSON.stringify({ installed: { client_id: desktop.clientId, client_secret: desktop.clientSecret } }))).toEqual(desktop)
    expect(clientFromOption("")).toBeUndefined()
    expect(clientFromOption("nonsense")).toBeUndefined()
  })

  it("§15.1 auth — a Desktop client takes only a loopback redirect; a Web client only one it lists", () => {
    expect(redirectMismatch(desktop, undefined)).toBeUndefined()
    expect(redirectMismatch(desktop, "http://127.0.0.1:8080")).toBeUndefined()
    expect(redirectMismatch(desktop, "https://host.example/oauth/return")).toMatch(/loopback/)
    expect(redirectMismatch(web, undefined)).toMatch(/fixed redirect/)
    expect(redirectMismatch(web, "https://other.example/oauth/return")).toMatch(/not one of the Web client's/)
    expect(redirectMismatch(web, "https://host.example/oauth/return")).toBeUndefined()
  })
})
