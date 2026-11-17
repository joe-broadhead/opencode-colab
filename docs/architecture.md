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

The packages and who owns each file: [v0.1.0: the Day 0 contract and file ownership](v1-design.md).
