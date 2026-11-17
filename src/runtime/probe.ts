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
  /** Whether gcloud's `gce` marker exists now; only its removal is a signal (ephemeral auth deletes it). */
  readonly gcePresent: boolean
  /** False when the scoped config exceeded the probe's caps: the answer is refused, never read as clean. */
  readonly bounded: boolean
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
  /** True when the baseline had gcloud's `gce` marker and it is gone now: ephemeral auth deleted it (L17). */
  readonly gceRemoved: boolean
  /** False when the scoped config exceeded the probe's caps: the answer is refused, never read as clean. */
  readonly bounded: boolean
  readonly addedFiles: readonly string[]
  readonly executionCount: number
}

/**
 * The gcloud config a credential can live in or be configured by, relative to `content/.config` (review M-C). Everything
 * else gcloud writes — `logs/` on every command, the `.last_*` stamps, `config_sentinel` — is bookkeeping that changes
 * with a plain `!gcloud --version`, so hashing it would taint a runtime for good for no reason.
 */
export const PROBE_CONFIG_SCOPE_FILES: readonly string[] = ["active_config", "credentials.db", "access_tokens.db", "application_default_credentials.json"]
export const PROBE_CONFIG_SCOPE_DIRS: readonly string[] = ["configurations", "legacy_credentials"]
/** The caps: a config past them is refused as RUNTIME_UNVERIFIED (non-tainting), never read as clean. */
export const PROBE_CONFIG_MAX_FILES = 500
export const PROBE_CONFIG_MAX_DEPTH = 4
export const PROBE_CONFIG_MAX_BYTES = 1024 * 1024
/** The name a `gce` removal reports; its creation is not a signal. */
export const GCLOUD_GCE_MARKER = "gcloud-gce-removed"

/** The version recorded in `Calibration.snippetVersion`; the drift workflow flags a change to the facts it pins. */
export const PROBE_SNIPPET_VERSION = COLABTOOLS_FACTS_VERSION

/** The snippet. The request, the file list and gcloud's directory are interpolated, so the kernel and the parser agree. */
export function probeSnippet(request: ProbeRequest): string {
  return [
    "import json as _oc_json",
    "import hashlib as _oc_hash",
    "import os as _oc_os",
    "import stat as _oc_stat",
    "",
    `_OC_REQUEST = ${JSON.stringify(request)}`,
    "_OC_KEY = '_oc_colab_probe_baseline'",
    `_OC_FILES = ${JSON.stringify(CREDENTIAL_FILES)}`,
    `_OC_CONFIG = ${JSON.stringify(GCLOUD_CONFIG_DIR)}`,
    `_OC_SCOPE_FILES = ${JSON.stringify(PROBE_CONFIG_SCOPE_FILES)}`,
    `_OC_SCOPE_DIRS = ${JSON.stringify(PROBE_CONFIG_SCOPE_DIRS)}`,
    `_OC_MAX_FILES = ${PROBE_CONFIG_MAX_FILES}`,
    `_OC_MAX_DEPTH = ${PROBE_CONFIG_MAX_DEPTH}`,
    `_OC_MAX_BYTES = ${PROBE_CONFIG_MAX_BYTES}`,
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
    "def _oc_scoped(relative):",
    "    if relative in _OC_SCOPE_FILES:",
    "        return True",
    "    if relative in _OC_SCOPE_DIRS:",
    "        return True",
    "    for folder in _OC_SCOPE_DIRS:",
    "        if relative.startswith(folder + '/'):",
    "            return True",
    "    return False",
    "",
    "def _oc_config():",
    "    # Scoped and bounded (review M-C): only what holds or configures a credential, regular files only, at most",
    "    # _OC_MAX_FILES files, depth _OC_MAX_DEPTH, and the first _OC_MAX_BYTES of each file with its size and mtime.",
    "    # gcloud's own bookkeeping (logs/, .last_*, config_sentinel) changes with every command and is not evidence.",
    "    root = '/' + _OC_CONFIG",
    "    if not _oc_os.path.isdir(root):",
    "        return None",
    "    digest = _oc_hash.sha256()",
    "    files = []",
    "    bounded = True",
    "    for base, folders, names in _oc_os.walk(root):",
    "        relative_base = _oc_os.path.relpath(base, root).replace(_oc_os.sep, '/')",
    "        depth = 0 if relative_base == '.' else relative_base.count('/') + 1",
    "        if depth >= _OC_MAX_DEPTH:",
    "            beyond = [name if relative_base == '.' else relative_base + '/' + name for name in names + folders]",
    "            if any(_oc_scoped(entry) for entry in beyond):",
    "                bounded = False",
    "            folders[:] = []",
    "            continue",
    "        folders.sort()",
    "        for name in sorted(names):",
    "            relative = name if relative_base == '.' else relative_base + '/' + name",
    "            if not _oc_scoped(relative):",
    "                continue",
    "            path = _oc_os.path.join(base, name)",
    "            try:",
    "                info = _oc_os.lstat(path)",
    "            except OSError:",
    "                continue",
    "            if not _oc_stat.S_ISREG(info.st_mode):",
    "                continue",
    "            if len(files) >= _OC_MAX_FILES:",
    "                bounded = False",
    "                break",
    "            files.append(relative)",
    "            try:",
    "                # O_NOFOLLOW, split so this file holds no bare upper-case name that is not a code.",
    "                handle = _oc_os.open(path, _oc_os.O_RDONLY | getattr(_oc_os, 'O_' 'NOFOLLOW', 0))",
    "                with _oc_os.fdopen(handle, 'rb') as stream:",
    "                    head = stream.read(_OC_MAX_BYTES)",
    "            except OSError:",
    "                head = b''",
    "            digest.update((relative + ':' + str(info.st_size) + ':' + str(info.st_mtime_ns) + ':' + _oc_hash.sha256(head).hexdigest()).encode('utf-8', 'replace'))",
    "        if not bounded:",
    "            break",
    "    files.sort()",
    "    return {'files': files, 'digest': digest.hexdigest(), 'bounded': bounded}",
    "",
    "def _oc_gce():",
    "    return _oc_os.path.exists(_oc_os.path.join('/' + _OC_CONFIG, 'gce'))",
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
    "    gce = _oc_gce()",
    "    if _OC_REQUEST['mode'] == 'baseline':",
    "        globals()[_OC_KEY] = {'epoch': _OC_REQUEST['epoch'], 'mounts': mounts, 'files': files, 'config': config, 'gce': gce}",
    "        answer = {'mode': 'baseline', 'epoch': _OC_REQUEST['epoch'], 'drive_mount': _oc_drive(mounts), 'files': files, 'execution_count': _oc_count(), 'ram_bytes': _oc_ram(), 'gce_present': gce, 'bounded': bool(config is None or config['bounded'])}",
    "    else:",
    "        stored = globals().get(_OC_KEY)",
    "        if not isinstance(stored, dict):",
    "            answer = {'mode': 'compare', 'epoch': '', 'epoch_ok': False, 'restarted': True, 'drive_mount': False, 'mounts_changed': False, 'config_changed': False, 'gce_removed': False, 'bounded': True, 'added_files': [], 'execution_count': _oc_count()}",
    "        else:",
    "            before = set(stored['mounts'])",
    "            answer = {",
    "                'mode': 'compare',",
    "                'epoch': stored['epoch'],",
    "                'epoch_ok': stored['epoch'] == _OC_REQUEST['epoch'],",
    "                'restarted': False,",
    "                'drive_mount': _oc_drive(mounts),",
    "                'mounts_changed': any(entry not in before for entry in mounts),",
    "                # Only the credential-bearing config is compared: a gce marker appearing is not a signal, its",
    "                # removal is (ephemeral auth deletes it), and gcloud's own bookkeeping is out of scope.",
    "                'config_changed': stored['config'] != config,",
    "                'gce_removed': bool(stored.get('gce')) and not gce,",
    "                'bounded': bool((stored['config'] is None or stored['config']['bounded']) and (config is None or config['bounded'])),",
    "                'added_files': [name for name in files if name not in stored['files']],",
    "                'execution_count': _oc_count(),",
    "            }",
    `    print('${PROBE_SENTINEL} ' + _oc_json.dumps(answer, sort_keys=True))`,
    "",
    "_oc_run()",
    "",
  ].join("\n")
}

const BASELINE_KEYS = ["bounded", "drive_mount", "epoch", "execution_count", "files", "gce_present", "mode", "ram_bytes"] as const
const COMPARISON_KEYS = ["added_files", "bounded", "config_changed", "drive_mount", "epoch", "epoch_ok", "execution_count", "gce_removed", "mode", "mounts_changed", "restarted"] as const

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
    gcePresent: flag(record.gce_present, "gce flag"),
    bounded: flag(record.bounded, "bounds flag"),
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
    gceRemoved: flag(record.gce_removed, "gce flag"),
    bounded: flag(record.bounded, "bounds flag"),
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
