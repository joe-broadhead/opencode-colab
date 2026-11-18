# Configuration

Every option is optional; an unknown one is refused with `OPTIONS_INVALID`, so a typo cannot leave the plugin more open
than you meant. No option holds a secret: `tokenEnv` names an environment variable.

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-colab#v0.0.1", "options": { "access": "ask-changes" } }] }
```

| Option | Default | What it does |
| --- | --- | --- |
| `access` | `"all"` | `all`, `ask-changes` or `read-only`: what the generated default rules allow. |
| `accounts` | one `default`, backend `colab`, interactive | Alias → `{ backend, mode, access, drive, project, region, outputBucket, serviceAccount, runAsUser, oauthClient, scopes, tokenEnv, impersonate, budget }`. A named account's `access` is `read` until you set `write`. See [Sign-in and accounts](auth.md). |
| `oauthClient`, `redirectUri`, `callbackPort` | none | The Desktop OAuth client and the sign-in's redirect. |
| `allowAdcInHost` | `false` | Allow Application Default Credentials for enterprise accounts inside Jelly. |
| `accelerators` | `["NONE", "T4", "L4"]` | The accelerators consumer specs and Enterprise jobs may use. |
| `maxRuntimes` | `1` | Consumer runtimes of the plugin's own, running at once. |
| `keep` | `["/content/outputs/**"]` | Paths harvested before a runtime is released. |
| `autoReleaseMinutes` / `maxRuntimeHours` | `20` / `4` | When an idle consumer runtime of the plugin's own is released. |
| `enterpriseMachine` | `"e2-standard-4"` | Enterprise job compute when no template is named. |
| `jobTimeoutMinutes` | `60` | Enterprise `executionTimeout`, at most 1440. It is both the default and the ceiling: a plan's `timeoutMinutes` may only shorten it. |
| `maxJobUsd` / `maxJobUsdCeiling` | `5` / `50` | The Enterprise compute cost cap per job, and the most a call may raise it to. |
| `rates` | the bundled, dated table | USD/h overrides per machine or accelerator. |
| `automation` | `"auto"` | Idle release: on at `all`, off otherwise; `"on"` consents at any access; `"off"`. |
| `maxInlineBytes` / `maxOutputBytesPerCell` | `"32KiB"` / `"1MiB"` | Inline output per call; per cell written back. |
| `maxRunSeconds` | `21600` | The ceiling on a run's `timeoutSec` (default 1800). |
| `maxUploadBytes` / `maxDownloadBytes` | `"512MiB"` / `"2GiB"` | Transfer caps. |
| `allowSecretUpload` | `false` | Allow uploading secret-shaped files. |
| `pushOutputs` | `"strip"` | Whether outputs go to Drive with a push. |
| `workDir` | `".colab"` | Runs, harvests, downloads and sync records, inside the project. |
| `allowedRoots` | `[]` | Extra local roots, with OpenCode's `external_directory`. |
| `ledgerDays` | `90` | How long the run ledger keeps a finished run, and so how far back the `colab.runs` source reaches. |
| `planTtlSeconds` | `300` | How long a plan stays committable. |
| `provisioningMarginMinutes` | `10` | Added to `executionTimeout` when checking a schedule for overlap. |
| `probeTimeoutSeconds` | `5` | Each credential probe on a runtime. |
| `probeKernelStartSeconds` | `60` | Starting the probe's own kernel at calibration. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the tested range. |

## Accounts and access

- With no `accounts` option there is one account, `default`, backend `colab`, interactive, at read and write.
- **A named account — every account you name in `accounts` — is read-only until you set its `access` to
  `"write"`.** On a read account every change tool and `colab_plan` answer `ACCOUNT_READ_ONLY` before any permission
  ask or network call; reads and the sources work.
- One backend per account: a person with both makes two, for example `personal` (`colab`) and `work` (`enterprise`,
  with `project`, `region`, `outputBucket` and `serviceAccount`).

```json
{
  "accounts": {
    "personal": { "backend": "colab", "access": "write" },
    "work": { "backend": "enterprise", "project": "my-project", "region": "us-central1", "outputBucket": "gs://my-bucket/colab", "serviceAccount": "notebooks@my-project.iam.gserviceaccount.com", "access": "write" }
  }
}
```

## What bounds hold with OpenCode closed

- A consumer run's watchdog interrupts it at `timeoutSec` (30 minutes by default, at most `maxRunSeconds`).
- An Enterprise job stops at its `executionTimeout` (`jobTimeoutMinutes`); a schedule needs `maxRunCount` or an
  `endTime`, and its shortest gap between runs must exceed the timeout plus `provisioningMarginMinutes`.
- The idle release (`autoReleaseMinutes`, `maxRuntimeHours`) runs only while OpenCode runs, and only at `access: all`
  unless `automation` is `"on"`.

## Errors

Every code, with what it means and the next step, is in [Errors](errors.md), generated from the plugin's one table.
