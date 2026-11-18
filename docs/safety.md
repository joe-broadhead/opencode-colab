# Safety

Unofficial plugin. Not affiliated with Google.

What the plugin treats as a change, what it promises about the runtimes it runs code on, what it does with secrets
and untrusted text, and every limit it has — including the ones only a live check against Google can settle.

## What counts as a change

| Action | Kind | How |
| --- | --- | --- |
| Read notebooks, outputs, runtimes, specs, jobs, schedules, files on a runtime of the plugin's own | read | the read tools |
| Edit or create a local notebook | change, local | `colab_edit`, after OpenCode's own `edit` permission |
| Run code or cells, install packages | change | `colab_run`; at `ask-changes` its ask shows the code |
| Upload a workspace file to a runtime of the plugin's own | change: data leaves the machine | `colab_upload`, after OpenCode's `read` |
| Download into the workspace | export | `colab_download`, after OpenCode's `edit` |
| Create a runtime, an Enterprise job or schedule; update or resume a schedule; push a notebook to Drive; stop an Enterprise runtime | change, costs | a plan: `colab_plan` → `colab_write` |
| Release a runtime, delete an Enterprise runtime, job or schedule, trash a Drive notebook | destructive | a plan: `colab_plan` → `colab_delete` |
| Pause a schedule; interrupt a run | change, nothing lost | `colab_pause`, `colab_cancel` |
| Run on a runtime the plugin did not create; share; IAM; templates; start an Enterprise runtime | refused | `RUNTIME_NOT_OURS`, `SHARE_UNSUPPORTED`, `ACTION_UNSUPPORTED` |

`access` decides what runs: at `all` every tool runs without asking — **code runs unasked, as with `bash`**; at
`ask-changes` the eight change tools ask, and `colab_delete` never offers "always"; at `read-only` they are denied and
`colab_plan` still previews. A call's own Stop works at every level. An account with `access: "read"` (every account
you name in `accounts`, until you set `write`) makes no change at all: `ACCOUNT_READ_ONLY`.

Scopes are not the fence: `colaboratory.readonly` returns the runtime's proxy token, which runs code, and an
Enterprise account holds `cloud-platform` at both levels. The plugin's own classification, and your rules, are the
fence.

## Runtimes are the agent's alone

Code runs, files are listed and files move only on runtimes the plugin created through the Colab API, with an id it
chose (`oc-<ulid>`), recorded in its ledger. Any other runtime is refused, with no override.

- **Guaranteed:** the plugin never puts a credential on a runtime; runs code only on runtimes it created; declines
  every credential request (`colab_request`, stdin); refuses any runtime where it has *observed* a credential or
  another client, for good.
- **Best effort:** detecting a credential or client that arrived and left between two probes, or one held in a form
  the probe has no marker for. The session nonce is not a secret: session names, nonce included, are listed by
  Jupyter and by Google's Colab MCP, and a client that opens a session with one of the plugin's session ids runs code
  in that kernel without a new session — a session without the nonce is foreign, and a client using one of the
  plugin's own sessions is seen only by the connections check, while attached. The probe shares the runtime with the
  agent's own code, which runs as root and may keep processes running after a run; it detects other clients' traces
  and accidents, not code written to hide from it. Only a release or a kernel restart ends such background processes;
  nothing else does.
- **Cannot see:** a secret the agent writes into code or uploads (screened, not prevented); what code reaches on the
  internet; Google-side mechanisms that leave no trace on the runtime (L15–L17).

How it checks:

1. **Calibration at creation**, before any agent code: whether Jupyter's REST API can see hidden paths, each kernel's
   baseline connection count, and a snapshot the probe compares against later (mounts, the credential files colabtools
   and gcloud write, a bounded digest of gcloud's credential-bearing configuration). A dirty first probe taints the
   runtime at birth.
2. **A probe before and after each run** (cached 30 seconds), in its own kernel, never the agent's: a fixed snippet
   the plugin wrote, reporting booleans only, never contents. It reports changes since calibration.
3. **Sessions and connections:** every session must carry the runtime's nonce, and no kernel may have more
   connections than its baseline plus the plugin's own.
4. **Any finding** answers `RUNTIME_HAS_CREDENTIALS` or `RUNTIME_SHARED` and taints the runtime for good: no more runs,
   no automatic release, cleanup only by plan. A probe that cannot finish answers `RUNTIME_UNVERIFIED` and taints
   nothing.
5. **No credential flow:** every `execute_request` has `allow_stdin: false`, and every `colab_request` (`drive.mount`,
   `google.colab.auth`, `userdata`) is declined at once; the run reports `COLAB_UI_API`.

| Check | Sees | Cannot see |
| --- | --- | --- |
| Mounts | A Drive or FUSE mount added since calibration, while it is mounted | One made and unmounted between probes |
| Credential files and gcloud's configuration | colabtools ADC, gcloud credentials and ADC, a change to gcloud's configuration — while present | Credentials held only in another kernel's memory; files written elsewhere by custom code |
| REST files | The same files, only where calibration found hidden paths visible | Everything hidden on stock Jupyter |
| Sessions with the nonce | Another client's session open now (the Colab MCP, VS Code, the web UI) | A session that opened, acted and closed between probes |
| Kernel connections | Another client attached to one of the plugin's kernels now | The same, after it detached |

The runtime's proxy token and its URL are credentials: never logged, returned or put in an error, refreshed before
they expire, and sent only to an https Google host. Runtimes the plugin creates are named `oc-…`; other clients,
Google's own Colab MCP server included, must not use them.

**Colab Enterprise:** the plugin runs no cells on Enterprise runtimes. Jobs run as the account's `serviceAccount`; with
none, a job is refused (`RUN_IDENTITY_REQUIRED`) unless `runAsUser: true`, which runs it as you and says so in the
preview. A job's code can use that identity anywhere in Cloud, which is why it should be a service account. Runtimes
with end-user credentials are flagged `EUC_RUNTIME`.

## Untrusted content

Cell sources, outputs, images, notebook metadata and Drive names and descriptions are data, never instructions: every
result that carries them has `trust: "untrusted"`; they are cut to size, ANSI codes stripped and control characters
escaped; and none of their text reaches a `message` or a `next`. A notebook owned or last modified by someone else is
marked `FOREIGN_NOTEBOOK`: a warning, not a fence. The `opencode-colab` skill tells the agent that a notebook fetched
by any tool is foreign and to read it before running it.

## Secrets

- **Uploads** refuse secret-shaped files (`.env*`, keys, `credentials*.json`, service-account keys, `.netrc`, cloud CLI
  configuration) with `UPLOAD_SECRET_REFUSED`, unless you set `allowSecretUpload`.
- **Shown text** — cell sources, inline outputs, and the `drive.*` and `job.create` previews — replaces a secret-shaped
  match with `[withheld: secret-shaped]` and warns `SECRET_WITHHELD`. Files saved to the workspace keep their bytes.
- **A job** sends the whole notebook to Google; its preview says first when a source is secret-shaped. Stripping
  outputs does not strip sources.
- **A Drive push** strips outputs by default (`pushOutputs`), since sharing a notebook shares its outputs.

## Sources

`colab.runs` reads only the plugin's local ledger, which holds no cell text, output, token or runtime URL; an event's
title is the plugin's own sentence, with the notebook's file name, and an event has no text, link or actors. A title
that is secret-shaped (a notebook named like a key) is refused for good (`refused[]`, reason `secret`).
`colab.runtimes` makes one listing call to Google per read. Both assert `colab.read` on the operation they read, so a
deny rule on `colab.read` stops them before anything is read. Neither ever writes to Google; `colab.runs` may append
an entry to the plugin's own ledger (below).

## Known limits

### Runtimes and the checks

- Everything in the guarantee's best-effort and cannot-see tiers above.
- The probe's calibration snapshot is kept on the runtime, where the agent's root-level code could rewrite it; the
  probe detects accidents and other clients, not code written to evade it.
- A credential-free `gcloud` command might create an empty credential database and taint the runtime; live check L17
  decides whether to test contents instead of existence.
- One OpenCode process owns a runtime at a time: a second session gets `RUNTIME_BUSY` until the first exits, and with
  `maxRuntimes: 1` it cannot create its own.
- The watchdog bounds a run, not a runtime's lifetime, and cannot interrupt C code that ignores signals.
- A run's output stream does not outlive the OpenCode process; the code keeps running until it ends or its time limit,
  output is not replayed to a new connection (L6), and the run then reads `detached`.
- Colab's own idle timeout and maximum lifetime are not published and not settable (L7, L7b, L7c).

### Costs

- Google publishes no per-accelerator compute-unit rate and no API for a balance or burn rate: consumer guards count
  runtime-hours and accelerators, and say so (`ratesKnown: false`).
- An Enterprise estimate is the dated price table's machine rate × the time limit; it excludes provisioning time and a
  template's own disk, and the table is for us-central1 unless `rates` names another region's prices.
- Enterprise jobs have no cancel method: `colab_cancel` cancels the job's create operation, and whether that stops a
  running job is live check L11 (`JOB_UNCANCELLABLE` names the time left otherwise).
- No automation touches Enterprise runtimes (Google gives them no idle signal); their template's idle shutdown is the
  only bound, flagged `IDLE_SHUTDOWN_OFF` when off.

### Enterprise jobs and schedules

- A job create whose answer was lost is reconciled by its id before any new create; if Google answers that the job is
  absent but lists its operations as an empty list, the notebook's next `job.create` stays `UNCERTAIN`.
- A retried create that joins one that landed late runs the earlier plan's notebook, as it was then.
- A schedule create has no id of its own: a lost answer is reconciled by its unique display name, and a duplicate is
  possible only if both the create and the reconcile listing fail.

### Notebooks and Drive

- A push while the notebook is open in Colab may be overwritten by Colab's autosave (L8b).
- Drive keeps at most 200 revisions of a file forever; past that a push does not pin the replaced revision
  (`REVISION_PIN_SKIPPED`).
- A symlink inside the project that points inside it is accepted when the project and the path are given one through
  the link and one not; nothing is read or written through the link.

### Sources

- `colab.runs` reads this machine's ledger: runs started from another computer are not listed, and a deleted ledger
  starts the history again (a consumer's cursor then answers one `gap: expired`).
- The ledger keeps `ledgerDays` (90): older history is lost, and a cursor that has not read it answers one
  `gap: expired`, never a silent skip. The declaration's `retentionDays` says 90, the default; another `ledgerDays`
  changes what the ledger keeps, not what the declaration says.
- A run is listed only once its end is recorded. A run whose output stream was lost (`detached`) stays unlisted until
  the plugin records its end.
- When a run's writer records its end without a `run.finished` entry, a `colab.runs` read appends the entry to the
  plugin's own ledger before it pages, so the run is listed on that read. This is the only write a source read makes.
- An Enterprise job create that did not land and was retried with the same id before any read is listed once, as the
  retry; a run record reopened after its end would keep its first listing (no writer does this).
- Each page reads the whole local ledger: about 0.3 s at 27,000 runs (90 days at 300 a day).
- `colab.runs` is owned by this computer's OS user (`os-user:<user>@<computer>`): the ledger records runs by account
  alias, so it lists an alias's runs whichever Google account was signed in when they ran.
- For `colab.runtimes`, an account whose owner Google does not name with a verified email — a `token` account, ADC
  with no service-account email — is named `colab:account:<alias>`, the plugin's own id, never an email.
- `colab.jobs` (every Enterprise job, the plugin's or not) is not shipped until L13. Jobs a schedule started are not
  the plugin's runs and are not in `colab.runs`.
- `colab.runtimes` lists at most 50 runtimes (`TOO_LARGE` beyond, or when Google's listing was cut), and gives no price
  for consumer runtimes.

### Sign-in

[Sign-in and accounts](auth.md#what-is-not-proven-yet) lists what the sign-in has not proven yet (L1, L3, L4, L14).

## Live checks not yet run

None has run. Until they do, every Google behaviour above is taken from Google's documentation, discovery documents
and MCP servers as fetched on 17 November 2026, and the tests run against fakes built from them.

| # | Checks |
| --- | --- |
| **L1** | **The gate:** a third-party Desktop OAuth client gets `colaboratory` consent and calls `runtimespecs.list` and `runtimes.create`; what enabling the Colab API requires; whether Workspace session control affects `colaboratory`. **It decides whether consumer execution ships enabled**: if it fails, the `colab` backend ships as notebook editing only and runtime tools answer `COLAB_API_UNAVAILABLE`. |
| L2 | Hidden-path visibility; the baseline `connections`; the kernel WebSocket through the runtime URL with the proxy header; the URL's host (the allow-list); token refresh mid-run; ranged reads; chunked writes; Jupyter's `connections` and `last_activity`. |
| L3 | Vertex notebook methods with `aiplatform` + `devstorage.read_only` instead of `cloud-platform`; session control's error on `cloud-platform`. |
| L4 | The runtime proxy accepts a token from a `colaboratory.readonly` grant. |
| L5 | `FAILED_PRECONDITION` reasons for capacity, usage and runtime count. |
| L6 | No output replay after a reconnect through Colab's proxy. |
| L7 | Colab's idle release of an API-created runtime with no browser attached, free and paid. |
| L7b | The compute-unit burn of an idle API runtime. |
| L7c | Whether Colab reclaims a runtime whose code is running when the only client is an API WebSocket. |
| L8 | Drive: the notebook MIME type, `drive.file` visibility in Colab's UI, revisions, `keepForever`. |
| L8b | A push while the notebook is open in Colab: whose write wins. |
| L9 | A declined `colab_request` returns within a second with an error. |
| L10 | Enterprise jobs: the direct-source size limit, the output layout in the bucket, the `executionTimeout` stop, `customEnvironmentSpec` with `e2-standard-4`. |
| L11 | Stopping a running job: cancelling the create operation, then deleting the job; billing after each. |
| L12 | A template's idle shutdown with no notebook connected; a stopped runtime's disk billing. |
| L13 | How long Google keeps execution jobs: decides `colab.jobs`. |
| L14 | Jelly's sign-in through its relay with the host's Google client; the verification class of `colaboratory`. |
| L15 | Whether `runtimes.list` includes browser-assigned runtimes; whether a browser or VS Code can attach to an API-created runtime; whether the Colab MCP's `execute_code` on an `oc-` runtime shows as a session without the nonce. |
| L16 | Whether Colab's Drive automount ever happens on an API-created runtime. |
| L17 | Whether a runtime's metadata server or ephemeral credential endpoint issues a token tied to you; which traces colabtools' ephemeral auth leaves (pins the probe). |
