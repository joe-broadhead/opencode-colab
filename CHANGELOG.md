# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- The repository scaffold, in the family's layout: the `jelly` declaration, the build to two self-contained bundles,
  the shared kit (r4.1) and `scripts/check.mjs` as the one check gate.
- The Day 0 contract: the ports, the twenty tools' schemas and result shapes, the error table, the `colab.*` action
  names, the plan store with `colab_plan` → `colab_write` / `colab_delete`, the run ledger, the `access` default rules,
  the tool registry with stubs, the `jelly` and `sources` declarations, and fakes for every port.
