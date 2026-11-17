# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
  snapshot (mounts, credential files, gcloud's config, a restart epoch) and reports only changes — a transient failure
  refuses without tainting; the loopback Colab API and the token-checking proxy in front of a Jupyter fake; and the
  weekly drift job over Google's discovery documents and colabtools.
