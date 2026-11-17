// The probe snippet itself, run by python3 in a sandbox (review M-C; the reviewer's `colab-2-sandbox-gen.ts` technique).
// This is the one test that executes the real kernel code: gcloud's own bookkeeping must not move the digest, the
// ephemeral-auth edit must, `gce` is a removal signal only, and the caps keep a large or deep config inside the probe
// budget. Skipped when the machine has no python3; `npm run check` runs it on the Linux and macOS runners.
import { execFileSync, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { probeSnippet } from "../../src/runtime/probe.js"

const python = spawnSync("python3", ["-c", "print(1)"], { encoding: "utf8" })
const available = python.status === 0 && python.stdout.trim() === "1"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Rewrites the snippet's absolute paths into a sandbox and stubs IPython's execution count. */
const rooted = (root: string, code: string) =>
  code
    .replace("root = '/' + _OC_CONFIG", `root = '${root}/' + _OC_CONFIG`)
    .replace("_oc_os.path.exists('/' + name)", `_oc_os.path.exists('${root}/' + name)`)
    .replace("_oc_os.path.join('/' + _OC_CONFIG, 'gce')", `_oc_os.path.join('${root}/' + _OC_CONFIG, 'gce')`)
    .replace("open('/proc/mounts')", `open('${root}/proc/mounts')`)
    .replace("open('/proc/self/status')", `open('${root}/proc/self/status')`)
    .replace(/    import IPython as _oc_ipython\n    shell = _oc_ipython\.get_ipython\(\)\n    return int\(shell\.execution_count\) if shell is not None and shell\.execution_count is not None else 0/, "    return 1")

/**
 * The driver keeps the probe kernel's globals alive across steps — that is what a real kernel does, and what the
 * baseline/comparison pair depends on. Steps create, edit and remove files between the two runs.
 */
const DRIVER = `import base64, io, contextlib, json, os, sys
g = {}
def run(path):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(open(path).read(), g)
    line = buf.getvalue().strip().split("\\n")[-1]
    return json.loads(line.split(" ", 1)[1])
answers = []
for step in json.loads(sys.argv[1]):
    op = step["op"]
    if op in ("baseline", "compare"):
        answers.append(run(step["file"]))
    elif op == "write":
        with open(step["path"], "wb") as handle:
            handle.write(base64.b64decode(step["data"]))
    elif op == "write_big":
        with open(step["path"], "wb") as handle:
            handle.write(bytes([step["byte"]]) * step["size"])
    elif op == "write_many":
        os.makedirs(step["dir"], exist_ok=True)
        for index in range(step["count"]):
            with open(os.path.join(step["dir"], "%s-%d.json" % (step["prefix"], index)), "wb") as handle:
                handle.write(b"{}\\n")
    elif op == "remove":
        try:
            os.remove(step["path"])
        except OSError:
            pass
    elif op == "mkdir":
        os.makedirs(step["path"], exist_ok=True)
    elif op == "fifo":
        os.mkfifo(step["path"])
    else:
        raise SystemExit("unknown step " + op)
print(json.dumps(answers))
`

interface Step {
  readonly op: "baseline" | "compare" | "write" | "write_big" | "write_many" | "remove" | "mkdir" | "fifo"
  readonly path?: string
  readonly dir?: string
  readonly data?: string
  readonly size?: number
  readonly byte?: number
  readonly count?: number
  readonly prefix?: string
}

/** A sandbox with a stock gcloud config, a stock `/proc/mounts` and `/proc/self/status`. */
const sandbox = (): string => {
  const root = mkdtempSync(join(tmpdir(), "colab-probe-"))
  dirs.push(root)
  const config = join(root, "content/.config")
  mkdirSync(join(config, "configurations"), { recursive: true })
  mkdirSync(join(config, "logs/2026.11.17"), { recursive: true })
  mkdirSync(join(root, "proc/self"), { recursive: true })
  writeFileSync(join(root, "proc/mounts"), "overlay / overlay rw\nproc /proc proc rw\ntmpfs /dev/shm tmpfs rw\nlxcfs /proc/cpuinfo fuse.lxcfs rw\n")
  writeFileSync(join(root, "proc/self/status"), "Name:\tpython3\nVmRSS:\t  1024 kB\n")
  writeFileSync(join(config, "active_config"), "default\n")
  writeFileSync(join(config, "config_sentinel"), "")
  writeFileSync(join(config, "configurations/config_default"), "[core]\nproject = stock\n")
  return root
}

/** Runs the steps in one Python process and returns each probe's answer, in order. */
const play = (root: string, steps: readonly Step[], timeout = 20_000): Record<string, unknown>[] => {
  const driver = join(root, "driver.py")
  writeFileSync(driver, DRIVER)
  writeFileSync(join(root, "base.py"), rooted(root, probeSnippet({ mode: "baseline", epoch: "e" })))
  writeFileSync(join(root, "cmp.py"), rooted(root, probeSnippet({ mode: "compare", epoch: "e" })))
  const script = steps.map((step) => ({
    ...step,
    ...(step.op === "baseline" ? { file: join(root, "base.py") } : {}),
    ...(step.op === "compare" ? { file: join(root, "cmp.py") } : {}),
  }))
  const output = execFileSync("python3", [driver, JSON.stringify(script)], { encoding: "utf8", timeout })
  return JSON.parse(output) as Record<string, unknown>[]
}

const config = (root: string, path: string) => join(root, "content/.config", path)

describe.skipIf(!available)("the probe snippet in a sandbox", () => {
  it("M-C: a stock config, unchanged, reports no change", () => {
    const root = sandbox()
    const [, compare] = play(root, [{ op: "baseline" }, { op: "compare" }])
    expect(compare).toMatchObject({ mode: "compare", config_changed: false, gce_removed: false, mounts_changed: false, bounded: true })
  })

  it("M-C: a credential-free `gcloud --version` (logs and .last_* stamps) is not a finding", () => {
    const root = sandbox()
    const [, compare] = play(root, [
      { op: "baseline" },
      { op: "write", path: config(root, "logs/2026.11.17/18.00.00.000000.log"), data: Buffer.from("Running [gcloud.version]\n").toString("base64") },
      { op: "write", path: config(root, ".last_update_check.json"), data: Buffer.from("{}").toString("base64") },
      { op: "write", path: config(root, ".last_survey_prompt.yaml"), data: Buffer.from("{}").toString("base64") },
      { op: "compare" },
    ])
    expect(compare).toMatchObject({ config_changed: false, gce_removed: false })
  })

  it("M-C: ephemeral auth's edit of configurations/config_default is a finding", () => {
    const root = sandbox()
    const [, compare] = play(root, [
      { op: "baseline" },
      { op: "write", path: config(root, "configurations/config_default"), data: Buffer.from("[core]\nproject = ephemeral\n").toString("base64") },
      { op: "compare" },
    ])
    expect(compare).toMatchObject({ config_changed: true })
  })

  it("M-C: a gce removal is its own signal, its creation is not", () => {
    const created = sandbox()
    const [, afterCreate] = play(created, [
      { op: "baseline" },
      { op: "write", path: config(created, "gce"), data: Buffer.from("{}").toString("base64") },
      { op: "compare" },
    ])
    expect(afterCreate).toMatchObject({ config_changed: false, gce_removed: false })

    const removed = sandbox()
    writeFileSync(config(removed, "gce"), "{}")
    const [baseline, afterRemove] = play(removed, [{ op: "baseline" }, { op: "remove", path: config(removed, "gce") }, { op: "compare" }])
    expect(baseline).toMatchObject({ gce_present: true })
    expect(afterRemove).toMatchObject({ gce_removed: true })
  })

  it("M-C: an 8 MiB scoped file answers within the 5 s probe budget", () => {
    const root = sandbox()
    writeFileSync(config(root, "credentials.db"), Buffer.alloc(8 * 1024 * 1024, 7))
    const started = Date.now()
    const [, compare] = play(root, [{ op: "baseline" }, { op: "compare" }], 5_000)
    expect(compare).toMatchObject({ config_changed: false, bounded: true })
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it("M-C: a FIFO in the config directory neither blocks nor counts", () => {
    const root = sandbox()
    // `credentials.db` is in scope: a FIFO there must be skipped by the regular-file check, not opened.
    const [, afterFifo] = play(root, [{ op: "fifo", path: config(root, "credentials.db") }, { op: "baseline" }, { op: "compare" }], 5_000)
    expect(afterFifo).toMatchObject({ config_changed: false, bounded: true })
    const [, afterFile] = play(root, [
      { op: "baseline" },
      { op: "remove", path: config(root, "credentials.db") },
      { op: "write", path: config(root, "credentials.db"), data: Buffer.from("sqlite\n").toString("base64") },
      { op: "compare" },
    ])
    expect(afterFile).toMatchObject({ config_changed: true })
  })

  it("M-C: more than 500 scoped files is refused as bounded false, never as clean", () => {
    const root = sandbox()
    const [, compare] = play(root, [{ op: "baseline" }, { op: "write_many", dir: config(root, "configurations"), count: 501, prefix: "extra" }, { op: "compare" }])
    expect(compare).toMatchObject({ bounded: false })
  })

  it("M-C: a scoped tree deeper than 4 is refused as bounded false", () => {
    const root = sandbox()
    const [, compare] = play(root, [
      { op: "baseline" },
      { op: "mkdir", path: config(root, "configurations/a/b/c/d") },
      { op: "write", path: config(root, "configurations/a/b/c/d/deep.json"), data: Buffer.from("{}").toString("base64") },
      { op: "compare" },
    ])
    expect(compare).toMatchObject({ bounded: false })
  })
})
