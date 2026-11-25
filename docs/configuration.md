# Configuration

All options are optional. A key that is not in the schema is refused with `OPTIONS_INVALID` rather than ignored.

<!-- generated:configuration -->
| Option | Type | Default | Description |
|---|---|---|---|
| `access` | `all` \| `ask-changes` \| `read-only` | `"all"` |  |
| `accounts` | object | — |  |
| `oauthClient` | string | — |  |
| `redirectUri` | string | — |  |
| `callbackPort` | integer | — |  |
| `allowAdcInHost` | boolean | `false` |  |
| `accelerators` | array | `["NONE","T4","L4"]` |  |
| `maxRuntimes` | integer | `1` |  |
| `keep` | array | `["/content/outputs/**"]` |  |
| `autoReleaseMinutes` | integer | `20` |  |
| `maxRuntimeHours` | number | `4` |  |
| `enterpriseMachine` | string | `"e2-standard-4"` |  |
| `jobTimeoutMinutes` | integer | `60` |  |
| `maxJobUsd` | number | `5` |  |
| `maxJobUsdCeiling` | number | `50` |  |
| `rates` | object | — |  |
| `automation` | `auto` \| `on` \| `off` | `"auto"` |  |
| `maxOutputBytesPerCell` | value | — |  |
| `maxRunSeconds` | integer | `21600` |  |
| `maxUploadBytes` | value | — |  |
| `maxDownloadBytes` | value | — |  |
| `allowSecretUpload` | boolean | `false` |  |
| `pushOutputs` | `strip` \| `keep` | `"strip"` |  |
| `workDir` | string | `".colab"` |  |
| `allowedRoots` | array | `[]` |  |
| `ledgerDays` | integer | `90` |  |
| `provisioningMarginMinutes` | integer | `10` |  |
| `probeTimeoutSeconds` | integer | `5` |  |
| `probeKernelStartSeconds` | integer | `60` |  |
| `allowUntestedHost` | boolean | `false` |  |
<!-- /generated:configuration -->

## Examples

Ask before every change:

```json
{ "plugins": [{ "package": "github:we-the-rebel-alliance/colab-plugin#v<version>", "options": { "access": "ask-changes" } }] }
```

Two accounts, one read-only, and a runtime cap:

```json
{
  "plugins": [{
    "package": "github:we-the-rebel-alliance/colab-plugin#v<version>",
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
    "package": "github:we-the-rebel-alliance/colab-plugin#v<version>",
    "options": {
      "accounts": { "work": { "backend": "enterprise", "project": "my-project", "region": "us-central1", "outputBucket": "gs://my-notebooks/output" } }
    }
  }]
}
```
