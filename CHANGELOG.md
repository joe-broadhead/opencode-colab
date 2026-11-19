# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- A source install, or any install that is not a tagged release, answers `NOT_RELEASED` and sends nothing to Google.
  `colab_edit` still edits a local notebook. The handlers stay; a tagged install runs them. There is no release tag yet.

- The repository scaffold, in the family's layout: the `jelly` declaration, the build to two self-contained bundles,
  the shared kit (r4.1) and `scripts/check.mjs` as the one check gate.
- The Day 0 contract: the ports, the twenty tools' schemas and result shapes, the error table, the `colab.*` action
  names, the plan store with `colab_plan` → `colab_write` / `colab_delete`, the run ledger, the `access` default rules,
  the tool registry with stubs, the `jelly` and `sources` declarations, and fakes for every port.
- Package C, notebooks: the nbformat 4 model (byte-stable unchanged files, ids derived in memory, outputs merged by
  cell id), `colab_find`, `colab_notebook`, `colab_edit`, the Drive pull with sync records, the `drive.create`,
  `drive.update` and `drive.trash` plans with outputs stripped by default, the foreign-origin warning and the source
  secret screen.
- The runtime transport (package B): the Colab API v1beta client with its create LRO, `requestId` join and Google's
  answers as the plugin's codes; the runtime protocol over Jupyter's REST API and the kernel WebSocket, with the
  proxy-token and runtime-URL checks, the one-owning-process lease, `allow_stdin: false`, the `colab_request` decline,
  chunked contents writes and the run watchdog; the agent-only check, whose probe kernel keeps its own calibrated
  snapshot (mounts, credential files, a scoped and bounded digest of gcloud's credential-bearing config, a restart
  epoch) and reports only changes, a transient failure refusing without tainting; the loopback Colab API and the
  token-checking proxy in front of a Jupyter fake; and the weekly drift job over Google's discovery documents and
  colabtools.
- Execution (package D): `colab_run` on a calibrated, untainted runtime of the plugin's own, with the pre- and
  post-run credential checks under one ask whose metadata carries each cell's first lines, the sources' sha256 and the
  shell, install and network flags; capture of Jupyter's outputs (streams, display updates, rich files, `outputs.jsonl`)
  with the inline caps and the secret screen; the write-back merge through the notebook store's per-path lock;
  `colab_execution`, `colab_cancel`, `colab_upload`, `colab_download`, `colab_specs`, `colab_runtimes` and
  `colab_files`; and the `runtime.create` and consumer `runtime.delete` plans, which calibrate a new runtime and call
  the one release function.
- Package G, sources: the `colab.runs` source (`colab_events_list`), one event per finished run or Enterprise job from
  the plugin's own ledger, with a cursor on the ledger log's sequence number — a run is listed when its end is
  recorded, once, behind nothing; a burst of any size drains; a pruned or deleted ledger answers one
  `gap: expired` from where the cursor's history ended — and a read that gives a finished run with no log entry its
  entry; the `colab.runtimes` snapshot (`colab_runtimes_read`) as a `list` of at most 50; the source `probe`, naming
  `colab.runs`' owner as this computer's user (the ledger is local) and `colab.runtimes`' as the signed-in Google
  account, never `verified: false`; and `npm run conformance`, the contract's kit over both
  sources, writing `reports/conformance-report.json`.
- The skills: the `opencode-colab` workflow (plans with `params`, commits with only a `planId`, accounts, the
  guarantee, costs, the sources) and `opencode-colab-notebooks` with ten worked examples, each run against the fakes by
  the tests.
- The docs: the README, [Safety](docs/safety.md) (the guarantee, every known limit, the live checks not yet run),
  and the sources in [Scripting](docs/scripting.md) and [In Jelly](docs/jelly.md).

- Package F, cost, cleanup and status: harvest-then-release, the idle rule and automation, budgets, `colab_status`,
  the hooks, `/colab-cleanup`, and the Cost and Automation rows.
