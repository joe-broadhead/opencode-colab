# Configuration

All options are optional. A key that is not in the schema is refused with `OPTIONS_INVALID` rather than ignored.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` | The plugin's ceiling for every method: all runs reads and changes, ask-changes asks before every change, and read-only refuses every change. |
| `accounts` | object | — | One entry per account alias. default is used when a call names none; each entry chooses backend, sign-in mode, access and budget. With no entries the plugin has one write default Colab account, and every other alias defaults to read. |
| `oauthClient` | string | — | The Google OAuth Desktop client id used for interactive sign-in; an account's own oauthClient wins. The client secret is never an option. |
| `redirectUri` | string | — | The OAuth redirect URI. When set, callbackPort is required and the client must register that URI; when unset the plugin listens on a free loopback port. |
| `callbackPort` | integer | — | The loopback port for the OAuth callback. It is required with redirectUri; when neither is set the operating system picks a free port. |
| `allowAdcInHost` | boolean | `false` | Allow Application Default Credentials inside the OpenCode host. Off by default: a host process uses the integration sign-in, and ADC is for headless or enterprise use. |
| `accelerators` | array | `["NONE","T4","L4"]` | Accelerator types a runtime may select, matched case-insensitively (default NONE, T4, L4). A spec outside the list is refused. |
| `maxRuntimes` | integer | `1` | The most runtimes of the plugin's own that one account may hold at once, from 1 to 10 (default 1). A create over the cap is refused. |
| `keep` | array | `["/content/outputs/**"]` | Runtime glob patterns kept when a runtime is released (default /content/outputs/**). Everything else on the runtime is reported as lost. |
| `autoReleaseMinutes` | integer | `20` | Minutes a runtime may sit idle before cleanup releases it, from 5 to 1440 (default 20). |
| `maxRuntimeHours` | number | `4` | The longest a runtime may live before cleanup releases it, from 0.5 to 24 hours (default 4). |
| `enterpriseMachine` | string | `"e2-standard-4"` | The Vertex AI machine type for an Enterprise job when its plan does not name one (default e2-standard-4). |
| `jobTimeoutMinutes` | integer | `60` | The longest an Enterprise job may run, from 1 to 1440 minutes (default 60); a plan may ask for less but not more. |
| `maxJobUsd` | number | `5` | The default per-job cost ceiling in USD (default 5). A plan may raise it up to maxJobUsdCeiling. |
| `maxJobUsdCeiling` | number | `50` | The hard per-job cost ceiling in USD (default 50). A plan's maxUsd may not exceed it. |
| `rates` | object | — | USD-per-hour overrides by machine name, accelerator type or short name, and disk (per GiB-hour). Outside the price table's region every component must be given; inside it an override replaces the table's rate. |
| `automation` | `auto` \| `on` \| `off` | `"auto"` | Whether the plugin runs its background idle-release loop: auto when it owns the lock and access is all, on whenever it owns the lock, off never (default auto). |
| `maxOutputBytesPerCell` | value | `1048576` | The most output one cell may capture, as bytes or a size such as 1MiB (default 1048576, 1MiB). Extra output is cut and flagged. |
| `maxRunSeconds` | integer | `21600` | The longest a run may take before the kernel is interrupted, from 60 to 86400 seconds (default 21600). |
| `maxUploadBytes` | value | `536870912` | The largest upload the plugin may send in one file or notebook push, as bytes or a size (default 536870912, 512MiB). |
| `maxDownloadBytes` | value | `2147483648` | The largest file the plugin may bring into the project, as bytes or a size (default 2147483648, 2GiB): download, a Drive pull, job output or a GCS object. |
| `allowSecretUpload` | boolean | `false` | Allow upload of a file the secret screen flags (off by default). A flagged upload is refused and taints the runtime. |
| `pushOutputs` | `strip` \| `keep` | `"strip"` | How output cells are pushed to Drive: strip removes outputs (default), keep pushes them as they ran. |
| `workDir` | string | `".colab"` | The project-relative folder for run output, pulled files and the local ledger (default .colab). |
| `allowedRoots` | array | `[]` | Absolute folders outside the project that local notebook and download paths may use (default none). |
| `ledgerDays` | integer | `90` | Days run, runtime and job records stay in the local ledger, from 1 to 3650 (default 90). |
| `provisioningMarginMinutes` | integer | `10` | Minutes added to an Enterprise job's timeout when checking a schedule's cron gap, from 0 to 240 (default 10). |
| `probeTimeoutSeconds` | integer | `5` | Seconds each credential and client probe may take, from 1 to 120 (default 5). |
| `probeKernelStartSeconds` | integer | `60` | Seconds the probe's kernel may take to start during calibration, from 5 to 600 (default 60). |
| `allowUntestedHost` | boolean | `false` | Allow the plugin to load on an OpenCode version outside >=2.4.1 <2.5.0 (off by default). |
<!-- /generated:configuration -->

## Examples

Ask before every change:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/colab-plugin#v0.0.0", "options": { "access": "ask-changes" } }] }
```

Two accounts, one read-only, and a runtime cap:

```json
{
  "plugins": [{
    "package": "github:we-the-rebel-alliance/colab-plugin#v0.0.0",
    "options": {
      "accounts": { "work": { "access": "write" }, "personal": { "access": "read" } },
      "maxRuntimes": 1,
      "autoReleaseMinutes": 20
    }
  }]
}
```

An Enterprise account with a project, region and output bucket:

```json
{
  "plugins": [{
    "package": "github:we-the-rebel-alliance/colab-plugin#v0.0.0",
    "options": {
      "accounts": { "work": { "backend": "enterprise", "project": "my-project", "region": "us-central1", "outputBucket": "gs://my-notebooks/output" } }
    }
  }]
}
```
