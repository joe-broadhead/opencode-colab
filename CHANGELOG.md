# Changelog

## 0.0.0 (2026-11-25)

The first release on plugin-contract v0. It exposes Google Colab notebooks, runtimes, execution, and Colab Enterprise
jobs and schedules through 24 methods: 15 read, 7 write, 1 export and 1 delete. `colab.runs` is an events source over the
plugin's own ledger and `colab.runtimes` a table snapshot; `changed` is emitted after runtime and run writes. Accounts
are one OpenCode integration per alias, every change is a plan and commit where the product previews it, and `status`
is the contract's strict answer.

The package ships its bundle in `dist/` and has no install lifecycle script, so it installs as a git dependency.

### Removed since pre-4b

Compared with `origin/master` at `d9f59e3` (the 4a editing-only entry, with the pre-4a full surface as the baseline):

- `colab_plan` — split into `colab_plan_write` and `colab_plan_delete`; the contract commits one plan per change.
- `/colab-status` — renamed `/colab`; `usage` carries the rich facts the old status RPC returned.
- The `./tui` status dialog — `/colab` and `usage` are the status surface the lead must confirm.
- The `google-colab/status` and `google-colab.tools` RPC ids, and `describe` — replaced by the contract's `status`
  method and the `colab` RPC; `describe` is diagnostics only (contract §18).
- The `colab-default` integration id — the default is now `colab`, with `colab-<alias>` for the others.
