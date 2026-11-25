// Build the Release files for a tag: dist/, the conformance report, and SHA256SUMS. The workflow runs this in a
// read-only `build` job; the `publish` job only verifies the checksums and creates the GitHub Release.
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const tag = process.argv[2]
if (!tag || !/^v\d+\.\d+\.\d+(?:-|$)/.test(tag)) {
  console.error("usage: node scripts/release.mjs v<major>.<minor>.<patch>")
  process.exit(2)
}
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
if (tag !== `v${pkg.version}`) {
  console.error(`the tag ${tag} does not name package version ${pkg.version}`)
  process.exit(1)
}

const out = join(root, "release")
rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, "dist"), { recursive: true })
copyFileSync(join(root, "dist", "index.js"), join(out, "dist", "index.js"))

const report = execFileSync("npx", ["plugin-kit", "conformance", "--json"], { cwd: root, encoding: "utf8" })
writeFileSync(join(out, "conformance.json"), report.endsWith("\n") ? report : `${report}\n`)

const files = ["dist/index.js", "conformance.json"]
const sums = files.map((file) => {
  const digest = createHash("sha256").update(readFileSync(join(out, file))).digest("hex")
  return `${digest}  ${file}`
})
writeFileSync(join(out, "SHA256SUMS"), `${sums.join("\n")}\n`)
console.log(`release/${files.join(", ")} and SHA256SUMS written for ${tag} (${relative(root, dirname(join(out, files[0])))}/)`)
