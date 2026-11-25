// The shared secret screen (design §7.5), Day 0 code that packages C and E both call: kinds, never the text.
import { describe, expect, it } from "vitest"
import { redact, screenSecrets, WITHHELD } from "../../src/redact.js"

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
      ["Authorization: Bearer " + "a".repeat(24), "bearer-or-basic"],
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
    expect(screenSecrets(code)).toEqual({ text: code, matches: 0, found: false, kinds: [] })
    const secret = "ghp_" + "b".repeat(36)
    expect(screenSecrets(secret)).toEqual(screenSecrets(secret))
  })

  it("covers the redaction's token shapes too", () => {
    const jwt = ["eyJhbGciOi", "eyJzdWIiOi", "c2lnbmF0dXJl"].join(".")
    expect(screenSecrets(jwt).kinds).toContain("jwt")
    expect(redact(jwt)).toBe("[redacted]")
  })
})

describe("screenSecrets withholds what it finds, with no hex exemption", () => {
  const hex40 = "0123456789abcdef0123456789abcdef01234567"

  it("withholds a Weights & Biases key in both everyday forms, and a Hugging Face token", () => {
    for (const line of [`wandb.login(key="${hex40}")`, `os.environ["WANDB_API_KEY"] = "${hex40}"`, `login("hf_${"A1b2".repeat(9)}")`]) {
      const screened = screenSecrets(line)
      expect(screened.found, line).toBe(true)
      expect(screened.text, line).toContain(WITHHELD)
      expect(screened.text, line).not.toContain(hex40)
    }
    expect(screenSecrets(`login("hf_${"A1b2".repeat(9)}")`).kinds).toContain("huggingface-token")
  })

  it("keeps the plugin's own sha256: hash, and only that 64-hex form", () => {
    const hash = `sha256:${"a".repeat(64)}`
    expect(screenSecrets(`ifHash = "${hash}"`).text).toContain(hash)
    expect(screenSecrets(`checksum ${"a".repeat(64)}`).found).toBe(true)
  })

  it("withholds a whole private-key block once, and counts each match", () => {
    const block = `${KEY}\nMIIE${"x".repeat(60)}\n-----END PRIVATE KEY-----`
    const screened = screenSecrets(`a = """${block}"""\nb = "AKIA${"ABCDEFGHIJKLMNOP"}"`)
    expect(screened.matches).toBe(2)
    expect(screened.kinds).toEqual(["aws-key", "private-key"])
    expect(screened.text).not.toContain("MIIE")
  })

  it("covers the family's vendor prefixes", () => {
    for (const token of ["pk_" + "a".repeat(12), "rk_" + "b".repeat(12), "glpat-" + "c".repeat(20), "lin_api_" + "d".repeat(20)]) expect(screenSecrets(token).found, token).toBe(true)
  })
})
