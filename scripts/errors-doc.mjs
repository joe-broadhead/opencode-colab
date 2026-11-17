// Writes docs/errors.md from the one error table, src/domain/errors.ts (which imports nothing, so Node loads it by
// stripping its types). `--check` fails when the file differs instead of writing it.
import { readFileSync, writeFileSync } from "node:fs"

const { renderErrorDoc } = await import(new URL("../src/domain/errors.ts", import.meta.url).href)
const path = new URL("../docs/errors.md", import.meta.url)
const text = renderErrorDoc()
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== text) {
    console.error("docs/errors.md is not what src/domain/errors.ts generates. Run node scripts/errors-doc.mjs.")
    process.exit(1)
  }
  console.log("docs/errors.md matches the error table.")
} else writeFileSync(path, text)
