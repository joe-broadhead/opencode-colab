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
| `RULES_NOT_ADDED` | failed | The plugin's default permission rules could not be added, so Colab tools may run without asking. | Restart OpenCode. |
| `STATUS_UNAVAILABLE` | failed | Colab status is unavailable right now. | Try again in a few seconds; if it persists, restart OpenCode. |

## Warnings

| Code | Meaning |
| --- | --- |
