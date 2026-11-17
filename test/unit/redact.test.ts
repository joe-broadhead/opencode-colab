// The shared secret screen (design §7.5), Day 0 code that packages C and E both call: kinds, never the text.
import { describe, expect, it } from "vitest"
import { redact, screenSecrets } from "../../src/redact.js"

const KEY = ["-----BEGIN", "PRIVATE KEY-----"].join(" ")

describe("screenSecrets", () => {
  it("names each kind it finds, sorted, and never returns the text", () => {
    const cases: [string, string][] = [
      [`key = """${KEY}\nabc"""`, "private-key"],
      ['{"type": "service_account", "project_id": "invented"}', "service-account-key"],
      [`api = "AIza${"x".repeat(35)}"`, "google-api-key"],
      ["AKIA" + "ABCDEFGHIJKLMNOP", "aws-key"],
      ["ghp_" + "a".repeat(36), "github-token"],
      ["xoxb-" + "1234567890-abc", "slack-token"],
      ["sk-" + "a".repeat(24), "api-key"],
      ['password = "hunter22hunter"', "secret-assignment"],
      ["Authorization: Bearer " + "a".repeat(24), "bearer-token"],
    ]
    for (const [text, kind] of cases) {
      const screened = screenSecrets(text)
      expect(screened.found, kind).toBe(true)
      expect(screened.kinds, kind).toContain(kind)
      expect(JSON.stringify(screened)).not.toContain(text)
    }
  })

  it("finds nothing in ordinary code, and gives the same answer twice (no carried regex state)", () => {
    const code = "import pandas as pd\ndf = pd.read_csv('/content/data.csv')\nprint(df.head())"
    expect(screenSecrets(code)).toEqual({ found: false, kinds: [] })
    const secret = "ghp_" + "b".repeat(36)
    expect(screenSecrets(secret)).toEqual(screenSecrets(secret))
  })

  it("covers the redaction's token shapes too", () => {
    const jwt = ["eyJhbGciOi", "eyJzdWIiOi", "c2lnbmF0dXJl"].join(".")
    expect(screenSecrets(jwt).kinds).toContain("jwt")
    expect(redact(jwt)).toBe("[redacted]")
  })
})
