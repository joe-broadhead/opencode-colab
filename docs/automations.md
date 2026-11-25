# Automations

`colab.runs` is a cursor feed over the plugin's own ledger. An OpenCode automation can read it, keep the cursor in its
durable state, and act on a new finished run. Use `tools.colab.events_list` with `source: "runs"` and never restart from
zero unless the cursor is lost; a page's `failed[]` holds the cursor back.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `colab.runs` | `tools.colab.events_list` | — | — | `bus` |
<!-- /generated:automations -->

Suggested cadence: every 15 minutes. A run that ends between reads is listed by the next page; the bus event makes the
next read sooner when an app is listening.
