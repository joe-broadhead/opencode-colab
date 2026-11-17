# Configuration

Every option is optional; an unknown one is refused with `OPTIONS_INVALID`, so a typo cannot leave the plugin more open
than you meant. No option holds a secret.

```json
{ "plugins": [{ "package": "github:joe-broadhead/opencode-colab#v0.0.1", "options": { "access": "ask-changes" } }] }
```

| Option | Default | What it does |
| --- | --- | --- |
| `access` | `"all"` | `all`, `ask-changes` or `read-only`: what the generated default rules allow. |
| `allowUntestedHost` | `false` | Load on an OpenCode release outside the tested range. |

## Errors

Every code, with what it means and the next step, is in [Errors](errors.md), generated from the plugin's one table.
