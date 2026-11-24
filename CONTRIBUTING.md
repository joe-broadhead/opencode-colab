# Contributing

## Setup

- Node.js 24, with npm. CI uses Node.js 24.
- Bun 1.4 (CI uses 1.4.4). The host and pack tests run with `bun test`.
- macOS or Linux.

```sh
git clone https://github.com/we-the-rebel-alliance/colab-plugin.git
cd colab-plugin
npm ci --ignore-scripts
npm run check
```

No dependency needs install scripts, and OpenCode installs plugins without them, so always pass `--ignore-scripts`.

### Run your checkout in OpenCode

The shipped entry is editing-only. Provider modules remain latent and are tested with synthetic fixtures.
See [development history](docs/development-history.md) for work outside the release notes.

Build it, then add the clone's path to `plugins` in your OpenCode config instead of the release install:

```sh
npm run build
```

```json
{ "plugins": [{ "package": "/path/to/colab-plugin" }] }
```

## `npm run check`

One command, `scripts/check.mjs`, runs every stage in order and stops at the first failure. `node scripts/check.mjs
<stage>...` runs only the named stages.

| Stage | What it does |
| --- | --- |
| `typecheck` | `tsc` over `src/` and the tests. |
| `unit` | Vitest over `test/unit/`. |
| `kit` | The release kit's own tests. |
| `build` | esbuild bundles `dist/index.js` and `dist/tui.js`, and checks `NOTICE`. |
| `icons` | The family icon contract. |
| `host` | The built plugin in an embedded OpenCode 2.4.1 host, with every request off loopback blocked. |
| `latent` | Synthetic full-plugin host boundary checks on the SDK floor and in-memory conformance of a fixture descriptor. No collector, shipped source declaration, or release report. |
| `pack` | Packs, installs with scripts disabled and imports both entries. |
| `forbidden` | The forbidden APIs and private names. |
| `copies` | The shared kit files against their pinned hashes. |
| `whitelist` | `package.json` and `dist/` against the approved package shape. |
| `actionlint` | The workflows, when `actionlint` is on PATH. |

## Packages

The latent full plugin is built in packages A–G on the Day 0 contract. Before you change a file, find its owner in
[docs/v1-design.md](docs/v1-design.md#file-ownership); a package changes only its own files.

The repository is moving onto plugin-contract v0: the `jelly` and `sources` keys, the copied kit in `scripts/` and the
tools RPC are replaced there, not extended here.

## Errors

The error table is `src/domain/errors.ts`. After changing it, run `node scripts/errors-doc.mjs` to regenerate
`docs/errors.md`; a unit test fails when the two differ.

## Releases

Versions follow semantic versioning on the plugin's contract: its options, the tool names and actions, the
`/colab-status` command, the status RPC, the skill names and the default rules. The repository starts at `0.0.0`; the
first release of the rebuilt plugin comes with plugin-contract v0.

Each release is the GitHub tag `v<version>`, made only by `.github/workflows/release.yml` after the owner approves the
`release` environment. `package.json` stays `"private": true` and in canonical form.

A pull request's CI runs the one required `ci` job on Node 24.
