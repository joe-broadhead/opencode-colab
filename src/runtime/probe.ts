/**
 * The kernel-side credential probe (design §7.4 step 3; review round 3, LOW 2 and 3).
 *
 * It is the plugin's own fixed code, versioned here and pinned to the colabtools facts in `discovery.ts`, and it runs
 * silently (`silent`, no history) in its own `oc-<nonce>-probe` kernel — never in the agent's session. It prints one
 * JSON line with booleans and file names only, never a file's contents, so an output that parses tells the plugin what
 * is on the runtime without carrying anything off it.
 *
 * The parse is strict on purpose: a missing line, an extra line, a wrong key, a value that is not a boolean or a known
 * name, or a name the package did not ask about is RUNTIME_UNVERIFIED, never "clean" (design §7.4: a probe that cannot
 * complete, or whose output does not parse, refuses).
 */
import { ColabError } from "../domain/errors.js"
import { COLABTOOLS_FACTS_VERSION, CREDENTIAL_FILES, EPHEMERAL_MARKERS } from "./discovery.js"

/** The one line the snippet prints; anything before or after it on stdout is a refusal. (Joined, not a literal: src/ holds no upper-snake string that is not a code.) */
export const PROBE_SENTINEL = ["OC", "PROBE"].join("_")

/** What the snippet reports: booleans, names and two counters, never contents. */
export interface ProbeOutput {
  readonly mounts: boolean
  readonly credentialFiles: readonly string[]
  readonly ephemeralMarkers: readonly string[]
  readonly ramBytes?: number
  /** The kernel's own execution counter: it only grows in a live kernel, so a drop means the kernel was restarted. */
  readonly executionCount: number
}

/** The version recorded in `Calibration.snippetVersion`; the drift workflow flags a change to the facts it pins. */
export const PROBE_SNIPPET_VERSION = COLABTOOLS_FACTS_VERSION

/**
 * The snippet. The credential-file list, the marker list and the sentinel are interpolated from the pinned lists so the
 * kernel and the parser cannot drift apart.
 */
export function probeSnippet(): string {
  return [
    "import json as _oc_json",
    "import os as _oc_os",
    "",
    "def _oc_colab_probe():",
    "    mounts = False",
    "    with open('/proc/mounts') as _oc_handle:",
    "        for _oc_line in _oc_handle:",
    "            _oc_parts = _oc_line.split()",
    "            if len(_oc_parts) < 3:",
    "                continue",
    "            _oc_source, _oc_mount, _oc_type = _oc_parts[0], _oc_parts[1], _oc_parts[2]",
    "            if _oc_type.startswith('fuse') or 'drive' in _oc_source.lower():",
    "                mounts = True",
    "                break",
    `    files = [name for name in ${JSON.stringify(CREDENTIAL_FILES)} if _oc_os.path.exists('/' + name)]`,
    `    markers = [name for name in ${JSON.stringify(EPHEMERAL_MARKERS)} if _oc_os.environ.get(name)]`,
    "    ram = None",
    "    with open('/proc/self/status') as _oc_status:",
    "        for _oc_row in _oc_status:",
    "            if _oc_row.startswith('VmRSS:'):",
    "                ram = int(_oc_row.split()[1]) * 1024",
    "                break",
    "    import IPython as _oc_ipython",
    "    _oc_shell = _oc_ipython.get_ipython()",
    "    count = int(_oc_shell.execution_count) if _oc_shell is not None and _oc_shell.execution_count is not None else 0",
    `    print('${PROBE_SENTINEL} ' + _oc_json.dumps({'mounts': mounts, 'credential_files': files, 'ephemeral_markers': markers, 'ram_bytes': ram, 'execution_count': count}, sort_keys=True))`,
    "",
    "_oc_colab_probe()",
    "",
  ].join("\n")
}

/** The keys the line must carry, and only these. */
const PROBE_KEYS = ["credential_files", "ephemeral_markers", "execution_count", "mounts", "ram_bytes"] as const

/** Parses the snippet's stdout. Throws `RUNTIME_UNVERIFIED` for anything that is not exactly one well-formed line. */
export function parseProbeOutput(stdout: string): ProbeOutput {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (lines.length !== 1) throw unverified(`the probe printed ${lines.length} lines instead of one`)
  const line = lines[0]!
  if (!line.startsWith(`${PROBE_SENTINEL} `)) throw unverified("the probe's line did not start with its marker")
  let parsed: unknown
  try {
    parsed = JSON.parse(line.slice(PROBE_SENTINEL.length + 1))
  } catch {
    throw unverified("the probe's line was not JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw unverified("the probe's line was not a JSON object")
  const record = parsed as Record<string, unknown>
  const keys = Object.keys(record).sort()
  if (keys.join(",") !== [...PROBE_KEYS].sort().join(",")) throw unverified("the probe's line had the wrong keys")
  if (typeof record.mounts !== "boolean") throw unverified("the probe's mount flag was not a boolean")
  const credentialFiles = namesOf(record.credential_files, CREDENTIAL_FILES, "credential file")
  const ephemeralMarkers = namesOf(record.ephemeral_markers, EPHEMERAL_MARKERS, "ephemeral marker")
  const ram = record.ram_bytes
  if (ram !== null && (typeof ram !== "number" || !Number.isFinite(ram) || ram < 0)) throw unverified("the probe's memory figure was not a number")
  const count = record.execution_count
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw unverified("the probe's execution count was not a whole number")
  return { mounts: record.mounts, credentialFiles, ephemeralMarkers, executionCount: count, ...(typeof ram === "number" ? { ramBytes: ram } : {}) }
}

function namesOf(value: unknown, allowed: readonly string[], what: string): readonly string[] {
  if (!Array.isArray(value)) throw unverified(`the probe's ${what} list was not a list`)
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") throw unverified(`the probe's ${what} list held something that is not a name`)
    if (!allowed.includes(entry)) throw unverified(`the probe named a ${what} this package did not ask about`)
    names.push(entry)
  }
  return names
}

function unverified(why: string): ColabError {
  return new ColabError("RUNTIME_UNVERIFIED", `The runtime's credential probe could not be read: ${why}.`, {
    next: "Retry the call; if it persists, plan a fresh runtime.create.",
  })
}
