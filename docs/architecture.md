# Architecture

The plugin is one `Plugin.define` in `src/index.ts`. It calls `assertHost`, loads the options, builds the provider,
registers the accounts, and calls the contract's `register` once with the handler table. The register wires all 24 methods
through the agent tool, Code Mode and RPC, generates the access rules, and owns input checks, account resolution, plan ids,
permissions and the bus.

## Layers

| Layer | Files | Does |
| --- | --- | --- |
| Entry | `src/index.ts` | setup, accounts, register, commands, skills |
| Handlers | `src/handlers/` | one handler per method; no host API calls |
| Sources | `src/sources/` | the runs page and the runtimes table |
| Domain | `src/domain/` | operations, plan actions, error table, notebook shapes |
| Provider | `src/provider/` | Google APIs, the runtime protocol, Drive, GCS, Vertex, the ledger, cost |

`src/provider/` is the only directory that names a Google host or an API path. Handlers depend on the `Deps` interface in
`src/provider/index.ts`; a test supplies the in-memory fakes in `test/fakes/`.

## Data

- **Runs** are the plugin's own ledger under `$XDG_STATE_HOME/colab/ledger`: one JSON file per runtime and run, an
  append-only `events.jsonl`, one cross-process lock, pruned after `ledgerDays`. It never holds cell text, tokens or
  runtime URLs.
- **Cursors** are the contract's bound codec, keyed by `(colab, runs, account)`.
- **Plans** live in the register's per-instance store for 15 minutes; a plan commits once, as the account and method it
  was made for.
- **Snapshots** are built on read; nothing is cached.

## OpenCode APIs

Only the public `@opencode/plugin` 2.4.1 context: `app`, `location`, `options`, `integration`, `agent`, `tool`, `rpc`,
`permission`, `command`, `session` and `skill`. The bundle leaves `@opencode/plugin` external and inlines everything
else.
