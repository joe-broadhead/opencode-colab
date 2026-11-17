/**
 * The kernel-side credential probe (design §7.4 step 3; review rounds 3 and 4: LOW 2/3 and H1, M1).
 *
 * It is the plugin's own fixed code, versioned here and pinned to the colabtools facts in `discovery.ts`, and it runs
 * silently (`silent`, no history) in its own `oc-<nonce>-probe` kernel — never in the agent's session.
 *
 * **Calibrated, not absolute.** At calibration the snippet stores a snapshot in the probe kernel's own globals: every
 * mount in `/proc/mounts`, the credential files that exist, the listing and digest of gcloud's config directory, and a
 * random epoch. Every later probe recomputes the snapshot and reports only what changed, plus a Drive mount wherever it
 * is. That is what tells a stock runtime from one that has just been granted something: a stock runtime already has
 * FUSE mounts from the container, gcloud's `active_config`/`config_sentinel`, and the ephemeral-credential *addresses*
 * in its environment — none of which is evidence of a credential.
 *
 * **The epoch is the restart detector.** IPython's execution count never moves for a silent request, so the recorded
 * count cannot detect a restart; the stored baseline can. A kernel that was restarted lost its globals: the probe then
 * answers `restarted: true`, and the check refuses with RUNTIME_UNVERIFIED. The epoch is derived from the calibration
 * (runtime id, nonce, calibration time), so a later process can recompute it.
 *
 * The parse is strict: a missing line, an extra line, a wrong key, a value of the wrong type, or a file name the package
 * did not ask about is RUNTIME_UNVERIFIED, never "clean".
 */
import { ColabError } from "../domain/errors.js"
import { COLABTOOLS_FACTS_VERSION, CREDENTIAL_FILES, GCLOUD_CONFIG_DIR } from "./discovery.js"

/** The one line the snippet prints; anything before or after it on stdout is a refusal. (Joined, not a literal: src/ holds no upper-snake string that is not a code.) */
export const PROBE_SENTINEL = ["OC", "PROBE"].join("_")

/** What the snippet is asked to do. */
export interface ProbeRequest {
  readonly mode: "baseline" | "compare"
  /** The epoch calibration stored; the baseline saves it, the comparison must find it again. */
  readonly epoch: string
}

/** The baseline's answer: what the runtime held before any agent code, plus the restart marker. */
export interface ProbeBaseline {
  readonly epoch: string
  readonly driveMount: boolean
  readonly credentialFiles: readonly string[]
  readonly executionCount: number
  /** The probe kernel's own resident memory, for L2's record. */
  readonly ramBytes?: number
}

/** The comparison's answer: only what changed since the baseline. */
export interface ProbeComparison {
  readonly epoch: string
  readonly epochOk: boolean
  readonly restarted: boolean
  readonly driveMount: boolean
  readonly mountsChanged: boolean
  readonly configChanged: boolean
  readonly addedFiles: readonly string[]
  readonly executionCount: number
}

/** The version recorded in `Calibration.snippetVersion`; the drift workflow flags a change to the facts it pins. */
export const PROBE_SNIPPET_VERSION = COLABTOOLS_FACTS_VERSION

/** The snippet. The request, the file list and gcloud's directory are interpolated, so the kernel and the parser agree. */
export function probeSnippet(request: ProbeRequest): string {
  return [
    "import json as _oc_json",
    "import hashlib as _oc_hash",
    "import os as _oc_os",
    "",
    `_OC_REQUEST = ${JSON.stringify(request)}`,
    "_OC_KEY = '_oc_colab_probe_baseline'",
    `_OC_FILES = ${JSON.stringify(CREDENTIAL_FILES)}`,
    `_OC_CONFIG = ${JSON.stringify(GCLOUD_CONFIG_DIR)}`,
    "",
    "def _oc_mounts():",
    "    entries = []",
    "    with open('/proc/mounts') as _oc_handle:",
    "        for _oc_line in _oc_handle:",
    "            _oc_parts = _oc_line.split()",
    "            if len(_oc_parts) >= 3:",
    "                entries.append(_oc_parts[0] + '|' + _oc_parts[1] + '|' + _oc_parts[2])",
    "    return entries",
    "",
    "def _oc_config():",
    "    # Recursive on purpose (review round 5): ephemeral auth edits configurations/config_default, one level down, so a",
    "    # top-level listing misses it. Every file's name, size and content hash goes into one digest.",
    "    root = '/' + _OC_CONFIG",
    "    if not _oc_os.path.isdir(root):",
    "        return None",
    "    digest = _oc_hash.sha256()",
    "    files = []",
    "    for base, folders, names in _oc_os.walk(root):",
    "        folders.sort()",
    "        for name in sorted(names):",
    "            path = _oc_os.path.join(base, name)",
    "            relative = _oc_os.path.relpath(path, root).replace(_oc_os.sep, '/')",
    "            files.append(relative)",
    "            try:",
    "                size = _oc_os.path.getsize(path)",
    "                content = _oc_hash.sha256()",
    "                with open(path, 'rb') as handle:",
    "                    for block in iter(lambda: handle.read(1048576), b''):",
    "                        content.update(block)",
    "                mark = content.hexdigest()",
    "            except OSError:",
    "                size, mark = -1, '?'",
    "            digest.update((relative + ':' + str(size) + ':' + mark).encode('utf-8', 'replace'))",
    "    files.sort()",
    "    return {'files': files, 'digest': digest.hexdigest()}",
    "",
    "def _oc_drive(mounts):",
    "    for entry in mounts:",
    "        parts = entry.split('|')",
    "        if len(parts) < 3:",
    "            continue",
    "        if parts[2].startswith('fuse') and 'drive' in (parts[0] + parts[1] + parts[2]).lower():",
    "            return True",
    "    return False",
    "",
    "def _oc_ram():",
    "    with open('/proc/self/status') as _oc_status:",
    "        for _oc_row in _oc_status:",
    "            if _oc_row.startswith('VmRSS:'):",
    "                return int(_oc_row.split()[1]) * 1024",
    "    return None",
    "",
    "def _oc_count():",
    "    import IPython as _oc_ipython",
    "    shell = _oc_ipython.get_ipython()",
    "    return int(shell.execution_count) if shell is not None and shell.execution_count is not None else 0",
    "",
    "def _oc_run():",
    "    mounts = _oc_mounts()",
    "    files = [name for name in _OC_FILES if _oc_os.path.exists('/' + name)]",
    "    config = _oc_config()",
    "    if _OC_REQUEST['mode'] == 'baseline':",
    "        globals()[_OC_KEY] = {'epoch': _OC_REQUEST['epoch'], 'mounts': mounts, 'files': files, 'config': config}",
    "        answer = {'mode': 'baseline', 'epoch': _OC_REQUEST['epoch'], 'drive_mount': _oc_drive(mounts), 'files': files, 'execution_count': _oc_count(), 'ram_bytes': _oc_ram()}",
    "    else:",
    "        stored = globals().get(_OC_KEY)",
    "        if not isinstance(stored, dict):",
    "            answer = {'mode': 'compare', 'epoch': '', 'epoch_ok': False, 'restarted': True, 'drive_mount': False, 'mounts_changed': False, 'config_changed': False, 'added_files': [], 'execution_count': _oc_count()}",
    "        else:",
    "            before = set(stored['mounts'])",
    "            answer = {",
    "                'mode': 'compare',",
    "                'epoch': stored['epoch'],",
    "                'epoch_ok': stored['epoch'] == _OC_REQUEST['epoch'],",
    "                'restarted': False,",
    "                'drive_mount': _oc_drive(mounts),",
    "                'mounts_changed': any(entry not in before for entry in mounts),",
    "                'config_changed': stored['config'] != config,",
    "                'added_files': [name for name in files if name not in stored['files']],",
    "                'execution_count': _oc_count(),",
    "            }",
    `    print('${PROBE_SENTINEL} ' + _oc_json.dumps(answer, sort_keys=True))`,
    "",
    "_oc_run()",
    "",
  ].join("\n")
}

const BASELINE_KEYS = ["drive_mount", "epoch", "execution_count", "files", "mode", "ram_bytes"] as const
const COMPARISON_KEYS = ["added_files", "config_changed", "drive_mount", "epoch", "epoch_ok", "execution_count", "mode", "mounts_changed", "restarted"] as const

function lineOf(stdout: string): Record<string, unknown> {
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
  return parsed as Record<string, unknown>
}

function exactKeys(record: Record<string, unknown>, expected: readonly string[], mode: string) {
  const keys = Object.keys(record).sort()
  if (keys.join(",") !== [...expected].sort().join(",")) throw unverified(`the ${mode} line had the wrong keys`)
  if (record.mode !== mode) throw unverified(`the probe answered in ${String(record.mode)} mode`)
}

const text = (value: unknown, what: string): string => {
  if (typeof value !== "string") throw unverified(`the probe's ${what} was not a string`)
  return value
}

const flag = (value: unknown, what: string): boolean => {
  if (typeof value !== "boolean") throw unverified(`the probe's ${what} was not a boolean`)
  return value
}

const count = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw unverified("the probe's execution count was not a whole number")
  return value
}

function namesOf(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw unverified(`the probe's ${what} was not a list`)
  const names: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") throw unverified(`the probe's ${what} held something that is not a name`)
    if (!CREDENTIAL_FILES.includes(entry)) throw unverified(`the probe named a ${what} this package did not ask about`)
    names.push(entry)
  }
  return names
}

/** Parses the baseline's stdout. Throws `RUNTIME_UNVERIFIED` for anything that is not exactly one well-formed line. */
export function parseBaselineOutput(stdout: string): ProbeBaseline {
  const record = lineOf(stdout)
  exactKeys(record, BASELINE_KEYS, "baseline")
  const ram = record.ram_bytes
  if (ram !== null && (typeof ram !== "number" || !Number.isFinite(ram) || ram < 0)) throw unverified("the probe's memory figure was not a number")
  return {
    epoch: text(record.epoch, "epoch"),
    driveMount: flag(record.drive_mount, "mount flag"),
    credentialFiles: namesOf(record.files, "file list"),
    executionCount: count(record.execution_count),
    ...(typeof ram === "number" ? { ramBytes: ram } : {}),
  }
}

/** Parses the comparison's stdout. Throws `RUNTIME_UNVERIFIED` for anything that is not exactly one well-formed line. */
export function parseComparisonOutput(stdout: string): ProbeComparison {
  const record = lineOf(stdout)
  exactKeys(record, COMPARISON_KEYS, "compare")
  return {
    epoch: text(record.epoch, "epoch"),
    epochOk: flag(record.epoch_ok, "epoch flag"),
    restarted: flag(record.restarted, "restart flag"),
    driveMount: flag(record.drive_mount, "mount flag"),
    mountsChanged: flag(record.mounts_changed, "mounts flag"),
    configChanged: flag(record.config_changed, "config flag"),
    addedFiles: namesOf(record.added_files, "added file list"),
    executionCount: count(record.execution_count),
  }
}

/**
 * The probe kernel answered something the plugin cannot trust: not one line, an unknown key, a name the package did not
 * ask about. That is an integrity break, not an outage, so the check taints on it (review M2 while M1 stays closed) —
 * unlike a timeout or a transport failure, which refuses and leaves the runtime usable.
 */
export class ProbeOutputError extends ColabError {
  constructor(why: string) {
    super("RUNTIME_UNVERIFIED", `The runtime's credential probe could not be read: ${why}.`, {
      next: "Retry the call; if it persists, plan a fresh runtime.",
    })
    this.name = "ProbeOutputError"
  }
}

function unverified(why: string): ColabError {
  return new ProbeOutputError(why)
}
