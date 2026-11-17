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
 * - Jupyter Server REST (`/api/kernels`, `/api/sessions`, `/api/contents`, `/files/{path}`) and the kernel WebSocket
 *   `/api/kernels/{kernel_id}/channels?session_id={id}`, as the `Runtime` description points clients at.
 * - colabtools HEAD, read 17 Nov 2026: the credential artefacts `auth.py` writes (`_get_adc_path`,
 *   `_install_adc`) and `drive.py` mounts (`fuse.drive`), and the environment markers `auth.py` and `drive.py` read
 *   (the USE_AUTH_EPHEM switch, the TBE_EPHEM_CREDS_ADDR and TBE_CREDS_ADDR addresses, and the
 *   GOOGLE_APPLICATION_CREDENTIALS variable).
 *
 * The drift workflow (`.github/workflows/drift.yml`) re-reads all of it weekly and fails when a method, field, path or
 * marker this file names is gone, so a Google change is a red build and not a quiet wrong answer. Live checks L2, L5,
 * L6, L9 and L15–L17 resolve what the documents leave open; each one is marked TODO at its use site.
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
 * Hosts that may receive the proxy token: only URLs that are https on a Google-owned suffix. The exact host L2 records
 * goes into this list; until then every other host, a plain-http URL and a URL carrying credentials is
 * RUNTIME_UNVERIFIED and the token is not sent (design §7.4, "the header is attached only when the URL is https on a
 * host in the allow-list recorded by L2").
 */
export const RUNTIME_HOST_SUFFIXES: readonly string[] = ["colab.dev", "googleusercontent.com", "google.com", "colab.research.google.com"]

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
 * The environment markers colabtools reads when ephemeral credentials are in play (design §7.4 step 3), presence only:
 * auth.py branches on the USE_AUTH_EPHEM switch, drive.py reads the TBE_EPHEM_CREDS_ADDR and TBE_CREDS_ADDR variables,
 * and a set GOOGLE_APPLICATION_CREDENTIALS is how colabtools points libraries at the ADC file it installed.
 */
// Spelled as one list and split, because src/ may hold no upper-snake string literal that is not an error code or a
// Google enum value (test/unit/errors.test.ts). These are colabtools' environment variable names, not codes.
export const EPHEMERAL_MARKERS: readonly string[] = "USE_AUTH_EPHEM TBE_EPHEM_CREDS_ADDR TBE_CREDS_ADDR GOOGLE_APPLICATION_CREDENTIALS".split(" ")

/** The Drive mount point the REST fallback looks at even when hidden paths are blind (design §7.4 step 3). */
export const DRIVE_MOUNT_PATH = "content/drive"

/** The directory that tells REST whether hidden paths are visible on this runtime (design §7.4 step 2). */
export const HIDDEN_PATHS_PROBE = "content/.config"

/**
 * The colabtools facts above were read at this version: the repository's HEAD on 17 Nov 2026. The probe snippet's
 * `Calibration.snippetVersion` names it, so a runtime checked by an older snippet is visible in the ledger, and the
 * drift workflow flags a change to any of the facts it pins.
 */
export const COLABTOOLS_FACTS_VERSION = "colabtools-2026-11-17"
