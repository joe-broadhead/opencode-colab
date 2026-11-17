# Errors

Generated from `src/domain/errors.ts` by `node scripts/errors-doc.mjs`; a unit test fails when they differ. Every
message reads `CODE: What happened. Next step: What to do.` A tool result that fails carries `state`, `error` (the
code), `message` and `next`.

## Errors

| Code | state | Meaning | Next step |
| --- | --- | --- | --- |
| `HOST_UNTESTED` | refused | OpenCode is outside the supported range. | Update OpenCode or the plugin, or set the plugin option allowUntestedHost: true. |
| `OPTIONS_INVALID` | refused | A plugin option is unknown or has an invalid value. | Fix the plugin's options in opencode.json as the message says. |
| `SKILLS_INVALID` | refused | A bundled skill is missing or malformed. | Reinstall the plugin. |
| `CANCELLED` | failed | The call was stopped before it finished. | Call it again if you still need the result. |
| `INPUT_INVALID` | refused | The input does not fit the tool's schema. Nothing ran. | Check the input against the tool's schema, then call it again. |
| `ACCOUNT_UNKNOWN` | refused | The account alias is not configured. | Pass a configured alias; colab_status lists them. |
| `ACCOUNT_REQUIRED` | refused | More than one account is configured, none is named default, and the call named none. | Pass account with one of the aliases colab_status lists. |
| `NOT_IMPLEMENTED` | refused | This tool or plan action is declared but not built in this pre-release. | Use another tool, or wait for a release that builds it. |
| `RULES_NOT_ADDED` | failed | The plugin's default permission rules could not be added, so Colab tools may run without asking. | Restart OpenCode. |
| `TOOLS_NOT_REGISTERED` | failed | The Colab tools could not be registered. | Restart OpenCode. |
| `STATUS_UNAVAILABLE` | failed | Colab status is unavailable right now. | Try again in a few seconds; if it persists, restart OpenCode. |
| `LEDGER_UNAVAILABLE` | failed | The plugin's run ledger could not be read or written, or its lock was not released in time. | Try again; if it persists, check that the state folder is writable. |
| `AUTH_REQUIRED` | refused | No usable credential; reason session-control when a Workspace reauthentication policy expired a cloud-platform grant. | Run /connect and choose Colab (or opencode auth login colab-<alias>); for session control, sign in again, and the admin may exempt the client as a trusted app. |
| `AUTH_SCOPE_MISSING` | refused | The sign-in lacks the scope this call needs; Google was not called. | Sign in again at Read and write, or approve the scope. |
| `AUTH_CLIENT_REQUIRED` | refused | No OAuth client is configured. | Enter a Desktop client in /connect, or set oauthClient. |
| `ADC_UNAVAILABLE` | refused | Application Default Credentials found nothing. | Use interactive mode, or set GOOGLE_APPLICATION_CREDENTIALS for an enterprise account. |
| `ADC_REFUSED` | refused | ADC on a colab account, or ADC in Jelly without allowAdcInHost. | Use interactive mode; ADC is for enterprise accounts only. |
| `COLAB_API_UNAVAILABLE` | refused | Google refused the Colab API for this client or project. | Notebook editing still works; runs need an enterprise account; the operator enables colaboratory.googleapis.com. |
| `API_DISABLED` | refused | The Vertex AI, Compute, Dataform or Drive API is off in the project. | Open the enable link in the message. |
| `PERMISSION_DENIED` | refused | IAM refused the call; the message names the permission Google named. | Ask an admin for the named role (docs/auth.md). |
| `PROJECT_REQUIRED` | refused | The enterprise account lacks project or region. | Set accounts.<alias>.project and region. |
| `BUCKET_REQUIRED` | refused | The enterprise account lacks outputBucket. | Set accounts.<alias>.outputBucket. |
| `RUN_IDENTITY_REQUIRED` | refused | An Enterprise job with no serviceAccount and no runAsUser. | Set serviceAccount (recommended) or runAsUser: true. |
| `NOT_FOUND` | refused | The notebook, cell, runtime, job, schedule or file was not found. | List what exists with colab_find, colab_runtimes or colab_files. |
| `RUNTIME_NOT_OURS` | refused | The runtime was not created by this plugin. | Plan a runtime of the plugin's own with colab_plan({ action: "runtime.create" }). |
| `RUNTIME_HAS_CREDENTIALS` | refused | A Drive mount or a Google credential is on the runtime; it is now tainted for good. | Plan a fresh runtime.create, and release this one by plan. |
| `RUNTIME_SHARED` | refused | Another client's session or connection is on the runtime; it is now tainted for good. | Plan a fresh runtime.create. |
| `RUNTIME_UNVERIFIED` | refused | The runtime check could not complete, its output did not parse, the probe kernel was restarted or replaced, or the runtime URL is not an allowed Google host. | Retry; if it persists, plan a fresh runtime. |
| `SPEC_NOT_ELIGIBLE` | refused | The person's tier cannot use that runtime spec. | Pick an eligible spec from colab_specs. |
| `ACCELERATOR_NOT_ALLOWED` | refused | The accelerator is not in the accelerators option. | Pick an allowed spec; the person may add the accelerator. |
| `RUNTIME_CAP` | refused | maxRuntimes runtimes of the plugin's own are running. | Reuse the runtime the message names, or release one. |
| `CAPACITY_UNAVAILABLE` | failed | Google has no capacity for that spec now. | Pick another eligible spec, or try later. |
| `USAGE_LIMIT` | refused | Compute units or free usage are exhausted. | Tell the person; a CPU spec may still work. |
| `TOO_MANY_RUNTIMES` | refused | Colab's own runtime limit is reached. | Release one of the plugin's runtimes, or reuse one. |
| `RUNTIME_GONE` | failed | The runtime ended. | Plan a new runtime.create with the same spec. |
| `RUNTIME_BUSY` | refused | A release or stop while a run is active. | Stop the run with colab_cancel, or plan again with force. |
| `INTERACTIVE_UNSUPPORTED` | refused | colab_run on an enterprise account: Enterprise runs whole notebooks as jobs. | Plan colab_plan({ action: "job.create", notebook }). |
| `KERNEL_BUSY` | refused | The kernel session runs another run. | Wait with colab_execution, or use another session. |
| `KERNEL_DIED` | failed | The kernel died, often from memory. | Rerun; pick a high-memory spec if eligible. |
| `RUN_TIMEOUT` | failed | timeoutSec was reached and the kernel was interrupted. | Raise timeoutSec (up to maxRunSeconds), or use an Enterprise job. |
| `COLAB_UI_API` | failed | The code called drive.mount, auth, userdata or another Colab UI API; the plugin declined it. | Move files with colab_upload and colab_download; pass values in code. |
| `NOTEBOOK_INVALID` | refused | The file is not an nbformat 4 notebook. | Fix it, or recreate it with colab_edit and a create op. |
| `NOTEBOOK_CHANGED` | refused | The file differs from ifHash, or changed during a run (the outputs are kept under .colab/runs). | Read it again with colab_notebook, then edit. |
| `LOCAL_CHANGED` | refused | A pull would overwrite local edits that were not pushed. | Push first, or pull to another path. |
| `PATH_REFUSED` | refused | The path is outside the project and the allowed roots, or is a symlink. | Use a path inside the project. |
| `FILE_EXISTS` | refused | The destination exists and overwrite was not set. | Pass overwrite: true after the person agrees. |
| `FILE_TOO_LARGE` | refused | The file is over the size cap. | Split it, or raise maxUploadBytes or maxDownloadBytes. |
| `UPLOAD_SECRET_REFUSED` | refused | The file is secret-shaped (an env file, a key, a credential). | Don't upload it; the person may set allowSecretUpload. |
| `DRIVE_CONFLICT` | refused | Drive's head revision differs from the sync record's base. | Pull to another path, merge, and plan again. |
| `COST_CAP` | refused | The Enterprise compute estimate is over the cap. | Pick a smaller machine or a shorter timeout, or pass maxUsd up to maxJobUsdCeiling. |
| `ESTIMATE_UNKNOWN` | refused | The machine or accelerator is not in the dated price table. | Pick a priced machine, or add it to the rates option. |
| `SCHEDULE_UNBOUNDED` | refused | The schedule has no maxRunCount and no endTime. | Add a bound. |
| `SCHEDULE_OVERLAP` | refused | The shortest gap between occurrences is under executionTimeout plus the provisioning margin. | Widen the cron, or shorten the timeout. |
| `UNCERTAIN` | failed | A schedule create's answer was lost, and no schedule with the plan's display name was found. | Check colab_schedules before planning again. |
| `BUDGET_REACHED` | refused | The opt-in budget is spent. | Wait for the daily reset, or raise budget. |
| `JOB_FAILED` | failed | The job failed. | Read the output notebook and error with colab_execution({ job }). |
| `JOB_TIMEOUT` | failed | The job hit executionTimeout. | Read the output notebook with colab_execution({ job }). |
| `JOB_UNCANCELLABLE` | refused | Cancel did not stop the job. | Wait for the timeout; the message shows what remains. |
| `RESULTS_UNAVAILABLE` | failed | The output notebook is not in the bucket. | Check the job's state with colab_jobs, and the bucket. |
| `SHARE_UNSUPPORTED` | refused | Sharing is not part of this plugin. | Share with the gws plugin. |
| `ACTION_UNSUPPORTED` | refused | IAM, templates, setDefault and Enterprise runtime creation are not part of v0.1.0. | Use the Google Cloud console. |
| `PLAN_NOT_FOUND` | refused | No plan has this id. | Run colab_plan first. |
| `PLAN_ALREADY_USED` | refused | This plan was already committed, or its commit is running. | Create a new plan to repeat the change; check the earlier result first. |
| `PLAN_EXPIRED` | refused | The plan is older than planTtlSeconds. | Create a new plan. |
| `PLAN_CALLER_MISMATCH` | refused | A plan is bound to the session, agent and account that created it. | Plan again from this session. |
| `PLAN_CHANGED` | refused | What the plan previewed changed: eligibility, runtime state, the notebook hash, the Drive revision, or a cost estimate more than 10% higher. | Plan again and show the new preview. |
| `CATEGORY_MISMATCH` | refused | The plan's category is not this commit tool's. | Commit a write plan with colab_write and a delete plan with colab_delete, passing only {planId}. |
| `RATE_LIMITED` | failed | Google's quota refused the call after retries; retryAfterSec says when to retry. The Colab API quota is per client project, shared by every user of that client. | Make the same call after that delay. |
| `UNAVAILABLE` | failed | Google answered 5xx, or the network failed, after retries. | Make the same call later. |

## Warnings

| Code | Meaning |
| --- | --- |
| `FREE_TIER_PRIORITY` | The account is on Colab's free tier, which prioritises people working in a notebook; a run may be reclaimed. |
| `FOREIGN_NOTEBOOK` | The notebook was written or last changed by someone else. It is a warning, not a fence: read it before running it. |
| `REVISION_PIN_SKIPPED` | The Drive file already has 200 kept revisions, so the replaced revision is not pinned. |
| `EUC_RUNTIME` | An Enterprise runtime has end-user credentials on. |
| `IDLE_SHUTDOWN_OFF` | An Enterprise runtime's template has idle shutdown off, so nothing bounds its cost. |
| `SCOPE_WIDER_THAN_ACCESS` | The enterprise sign-in holds cloud-platform, which reaches more than the plugin's access level. |
| `SECRET_WITHHELD` | Secret-shaped text in a source or output was replaced with [withheld: secret-shaped]. |
| `OUTPUT_TRUNCATED` | Inline output was cut at the caps; the rest is in the run's files. |
| `UNHARVESTED` | A runtime's keep paths could not be harvested, so its release is blocked. |
| `DETACHED` | The run's output stream ended with an earlier OpenCode process; the code may still be running. |
| `BUDGET_WARN` | The opt-in budget is reached; the call ran because the budget's action is warn. |
| `RATES_UNKNOWN` | Consumer compute-unit rates are not published, so cost is counted in runtime-hours. |
