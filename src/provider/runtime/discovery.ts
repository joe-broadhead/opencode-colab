/**
 * The Google shapes this package relies on, in one place, pinned to what was read on 17 Nov 2026:
 *
 * - Colab API v1beta, discovery revision **20261115** (`https://colaboratory.googleapis.com/$discovery/rest?version=v1beta`):
 *   `runtimes.create` (POST `v1beta/runtimes`, query `runtimeId` and `requestId`, body `Runtime`, answer `Operation`),
 *   `runtimes.get` / `runtimes.delete` (path `v1beta/{+name}`, `name` = `runtimes/{runtime_id}`),
 *   `runtimes.list` (GET `v1beta/runtimes`, answer `{ runtimes }`), `runtimespecs.list` (GET `v1beta/runtimespecs`,
 *   answer `{ runtimeSpecs: [{ key, eligible }] }`), `getSubscription` (GET `v1beta/subscription`, answer `{ tier }`).
 *   `Runtime` = `{ name, runtimeSpec: Key, version?, connectionInfo: { url, token, expireTime } }`; `Key` =
 *   `{ variant, shape, accelerator }`; the proxy token header is `X-Colab-Runtime-Proxy-Token`.
 * - Colab API v1, revision 20261116: `colaboratory.operations.get` is `GET v1/{+name}` and `operations.wait` is
 *   **`GET v1/{+name}:wait`** with `name=operations/{id}` and the duration in the `timeout` query — the create's
 *   long-running operation is followed there (design §9.5's `operations.wait`; the REST reference's
 *   `colaboratory.operations.wait`).
 * - Jupyter Server REST (`/api/kernels`, `/api/sessions`, `/api/contents`, `/files/{path}`) and the kernel WebSocket
 *   `/api/kernels/{kernel_id}/channels?session_id={id}`, as the `Runtime` description points clients at. A contents
 *   save over 50 MB is sent in pieces: `chunk: 1` starts, `chunk: -1` ends, as the default `AsyncLargeFileManager`
 *   saves them and as Google's Colab MCP tells its clients to.
 * - colabtools HEAD, read 17 Nov 2026: the credential artefacts `auth.py` writes (`_get_adc_path`, `_install_adc`),
 *   the `fuse.drive` mount `drive.py` makes, and the one trace ephemeral auth leaves in gcloud's config
 *   (`_enable_metadata_server_for_gcloud` unsets a property and deletes `$CLOUDSDK_CONFIG/gce`).
 *
 * The revision and facts below are what this client was written against. The recorded fakes replay the same method,
 * field, path and fact shapes, so a Google change is caught by a failing test rather than a quiet wrong answer.
 */

/** The discovery revision the client was written against. */
export const COLAB_DISCOVERY_REVISION = "20261115"
/** The Colab API service root. The only host this client sends the access token to. */
export const COLAB_API_ORIGIN = "https://colaboratory.googleapis.com"
/** The scopes design §4 requests, one set per account access level. */
export const COLAB_SCOPE = "https://www.googleapis.com/auth/colaboratory"
export const COLAB_READ_SCOPE = "https://www.googleapis.com/auth/colaboratory.readonly"

/** The REST paths, without the service root. */
export const COLAB_API_PATHS = {
  runtimes: "v1beta/runtimes",
  runtimeSpecs: "v1beta/runtimespecs",
  subscription: "v1beta/subscription",
} as const

/**
 * The long-running-operation paths, without the service root: `GET v1/operations/{id}` and `GET v1/operations/{id}:wait`
 * with the `timeout` query (design §9.5; Colab API v1 discovery revision 20261116 — wait is a GET, not a POST).
 */
export const COLAB_OPERATION_PATHS = { get: "v1/operations", wait: "v1/operations" } as const
/** The `operations.wait` timeout query value (a google-duration). */
export const COLAB_OPERATION_WAIT_TIMEOUT = "3s"

/** The Jupyter server paths, without the runtime URL. */
export const JUPYTER_PATHS = {
  kernels: "api/kernels",
  sessions: "api/sessions",
  contents: "api/contents",
  files: "files",
} as const

/** The header Google's `ConnectionInfo` description names for the proxy token. */
export const PROXY_TOKEN_HEADER = "X-Colab-Runtime-Proxy-Token"

/**
 * Hosts that may receive the proxy token: only URLs that are https on a Google-owned suffix. Narrowed from the first
 * pass after review: no bare `google.com`, because the runtime proxy is not served from it, and L2 pins the exact
 * suffix before release (design §7.4, "the header is attached only when the URL is https on a host in the allow-list
 * recorded by L2"). Anything else is RUNTIME_UNVERIFIED and the token is not sent.
 */
export const RUNTIME_HOST_SUFFIXES: readonly string[] = ["colab.dev", "googleusercontent.com"]

/**
 * The credential files colabtools and gcloud write on a runtime (design §7.4 step 3), as paths below the runtime's
 * filesystem root. `auth.py` writes the first two (`_get_adc_path` returns `content/.adc/adc.json`, `_install_adc`
 * reads `content/.config/credentials.db`); gcloud writes the rest.
 */
export const CREDENTIAL_FILES: readonly string[] = [
  "content/.adc/adc.json",
  "content/.config/credentials.db",
  "content/.config/application_default_credentials.json",
  "root/.config/gcloud/credentials.db",
  "root/.config/gcloud/application_default_credentials.json",
]

/**
 * gcloud's config directory on a Colab runtime (the SDK config variable), and the one file in it whose disappearance means
 * ephemeral auth was enabled: `auth.py`'s `_enable_metadata_server_for_gcloud` deletes `gce`. The probe baselines the
 * directory's listing and digests at calibration and reports a change, never a presence — a stock runtime already has
 * `active_config` and `config_sentinel` here.
 */
export const GCLOUD_CONFIG_DIR = "content/.config"
/** The file ephemeral auth removes (design §7.4 step 3, pinned by L17). */
export const GCLOUD_GCE_FILE = "gce"
/** The marker name a change to that directory reports; the only observable trace of an ephemeral grant. */
export const GCLOUD_CONFIG_MARKER = "gcloud-config-changed"

/**
 * The environment variables colabtools reads are deliberately **not** probe markers (review H1): every standard Colab
 * runtime carries the ephemeral-credential addresses (drive.py indexes them with no default), and the ADC variable is
 * written into the calling kernel's own environment, which the probe kernel never sees. The fake runtime carries the
 * stock environment too, so a check that reads those variables again fails its tests.
 */

/** The Drive mount point the REST fallback looks at even when hidden paths are blind (design §7.4 step 3). */
export const DRIVE_MOUNT_PATH = "content/drive"

/** The directory that tells REST whether hidden paths are visible on this runtime (design §7.4 step 2). */
export const HIDDEN_PATHS_PROBE = GCLOUD_CONFIG_DIR

/**
 * The colabtools facts above were read at this version: the repository's HEAD on 17 Nov 2026. The probe snippet's
 * `Calibration.snippetVersion` names it, so a runtime checked by an older snippet is visible in the ledger, and the
 * drift workflow flags a change to any of the facts it pins.
 */
export const COLABTOOLS_FACTS_VERSION = "colabtools-2026-11-17"
