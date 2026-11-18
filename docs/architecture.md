# Architecture

The plugin is one server bundle (`dist/index.js`) and one TUI bundle (`dist/tui.js`). The server part registers, in
order: the default permission rules, the `colab` namespace and its twenty tools, the auth integrations, status
(`/colab-status` and the status RPC), the tools RPC for scripts, the skills, and the cost automation.

- **Contract** (`src/domain/`): the tools' schemas and result shapes, the error table, the action names and the plan
  actions. One definition each; the model's tools and the tools RPC are built from it.
- **Ports** (`src/ports.ts`, `src/deps.ts`): every boundary — Google's APIs, the runtime's Jupyter server, the
  agent-only check, the ledger, the plan store — as an interface. Each package implements its own; tests use the fakes
  in `test/fakes/`.
- **Tools** (`src/tools/`): one wrapper parses, resolves the account, asserts `colab.<tool>` once, runs the owning
  package's handler and maps errors to results.
- **Plans** (`src/domain/plans.ts`, `src/plans/route.ts`): `colab_plan` previews a costly or destructive change and
  stores a single-use plan; `colab_write` and `colab_delete` commit it.
- **Ledger** (`src/ledger/`): which runtimes are the plugin's own, every run, and the events the `colab.runs` source
  reads.
- **Packages** behind the ports: auth (`src/auth/`), the runtime transport and the agent-only check (`src/runtime/`),
  notebooks and Drive (`src/notebooks/`), execution (`src/execution/`), Enterprise jobs and schedules
  (`src/enterprise/`), cost, cleanup and status (`src/cost/`), and the sources (`src/sources/`).
- **Sources** (`src/sources/`): `colab_events_list` pages the ledger's log for `colab.runs` (a cursor on the log's
  sequence number, so a run is listed when its end is recorded), `colab_runtimes_read` answers the `colab.runtimes`
  snapshot from one listing call, and `probe` names the owner from the stored sign-in. They are the source contract's
  reads, through the same wrapper as every tool, and refuse with the contract's codes.
- **Tools RPC** (`src/tools-rpc.ts`): the twelve read tools and the probe as methods for scripts, through the source
  contract's transport. Changes are never methods.

The packages and who owns each file: [v0.1.0: the Day 0 contract and file ownership](v1-design.md).
