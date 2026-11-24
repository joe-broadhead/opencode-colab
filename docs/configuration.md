# Configuration

Add this plugin in OpenCode's `plugins` and pass only local options. Defaults:

| Option | Default | Meaning |
| --- | --- | --- |
| `access` | `all` | `all` allows local tools by default, `ask-changes` asks for edits, `read-only` denies them. The host's own file permissions and explicit Colab rules still apply. |
| `maxInlineBytes` | `32KiB` | Cap on native tool response text. |
| `maxDownloadBytes` | `2GiB` | Byte cap for local notebook reads; an existing option name, not a cloud download capability. |
| `allowedRoots` | `[]` | Additional local roots for an explicit notebook path; never searched by find. External paths still need `external_directory`. |
| `allowUntestedHost` | `false` | Explicitly opt in to loading outside the supported host range; status warns. |

If OpenCode does not apply the default rules to a custom agent, `ask-changes` and `read-only` refuse edits that would otherwise inherit only a blanket allow. Use an agent with the defaults or add an explicit `colab.edit` rule (`ask`, `deny` or `allow`) to that agent. File permission checks still apply.

Set sizes in bytes or use `KiB`, `MiB` or `GiB`. Unknown options and all provider options return `OPTIONS_INVALID`. Remove `accounts`, `workDir`, `ledgerDays`, `oauthClient`, `redirectUri`, `callbackPort`, `allowAdcInHost`, `accelerators`, `maxRuntimes`, `keep`, `autoReleaseMinutes`, `maxRuntimeHours`, `enterpriseMachine`, `jobTimeoutMinutes`, `maxJobUsd`, `maxJobUsdCeiling`, `rates`, `automation`, `maxRunSeconds`, `maxUploadBytes`, `allowSecretUpload`, `pushOutputs`, `maxOutputBytesPerCell`, `provisioningMarginMinutes`, `probeTimeoutSeconds`, `probeKernelStartSeconds` and `planTtlSeconds` from full-build configurations.
