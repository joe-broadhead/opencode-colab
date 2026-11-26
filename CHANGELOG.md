# Changelog

## 0.0.0 (2026-11-25)

The first release on plugin-contract v0. It exposes Google Colab notebooks, runtimes, execution, and Colab Enterprise
jobs and schedules through 24 methods: 15 read, 7 write, 1 export and 1 delete. `colab.runs` is an events source over the
plugin's own ledger and `colab.runtimes` a table snapshot; `changed` is emitted after every successful non-read method and every commit. Accounts
are one OpenCode integration per alias, every change is a plan and commit where the product previews it, and `status`
is the contract's strict answer.

The package ships its bundle in `dist/` and has no install lifecycle script, so it installs as a git dependency.
