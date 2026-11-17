# v0.1.0: the Day 0 contract and file ownership

The plugin's v0.1.0 is built in packages A–G on top of a Day 0 contract, so the packages build in parallel without
editing each other's files. This page is the contract's map: what Day 0 holds, who owns each file, and the decisions
Day 0 made where the design left a gap. The design itself (decisions, safety, cost, tests, live checks L1–L17) is the
reviewed design document; this page restates only what a package needs to build against.

## What Day 0 holds

| Piece | File | What it fixes |
| --- | --- | --- |
| Ports | `src/ports.ts` | Every boundary: Colab API, the runtime protocol (`openSession`, `execute`, `interrupt`, `files`, `kernels`, `sessions`), the agent-only check, Vertex, Drive, GCS, auth `token(account, scopes)`, the ledger, the plan store, `RunEvents` subscribe, the clock; and the seams between packages (`Release`, `EnterpriseRuns`, `DriveSync`). |
| Deps | `src/deps.ts` | One object with every port, built from each package's factory. Tools receive it; nothing imports another package's module. |
| Contract | `src/domain/contract.ts` | The 20 tools' input schemas and result shapes; every result is `{ state, …, error?, message?, next?, warnings? }`; `PLAN_PARAMS` per plan action. |
| Errors | `src/domain/errors.ts` | The one error table (design §12, plus the Day 0 additions below), the warnings, the source-code mapping, `ColabError`, and `docs/errors.md` generated from it. |
| Actions | `src/domain/actions.ts` | The 20 tools with class, owner and exposure; the `colab.*` action names; `colab.read` and `colab.probe` as permission-only reads; `colab.cleanup`; the operation ids; the §7.1 change table; the §7.2 plan actions with category, backend, owner and operation. |
| Plan store and routing | `src/domain/plans.ts`, `src/plans/route.ts` | Single-use plans, 300 s, bound to session, agent and account; `colab_plan` → `colab_write` / `colab_delete`, refusals, category checks, the commit's one assert. |
| Ledger | `src/ledger/store.ts` | `$XDG_STATE_HOME/opencode-colab/ledger/`: copy-on-write JSON per runtime and run, `events.jsonl`, a cross-process lock, pruning after `ledgerDays`. |
| Default rules | `src/permissions.ts` | The `access` → rules block: `colab.*` gets the change effect; the 12 read tools, `colab.read` and `colab.probe` allow; the 8 change tools get the change effect; `colab.cleanup` asks. |
| Registry | `src/tools/registry.ts`, `src/tools/spec.ts`, `src/tools/resources.ts`, `src/tools/types.ts` | Each tool's handler from its owner; the one wrapper that parses, resolves the account, asserts `colab.<tool>` once and maps errors to results. |
| Declarations | `package.json` `jelly`, `sources` | 22 jelly entries (20 tools and 2 permission-only reads); the `colab.runs` and `colab.runtimes` sources. |
| Fakes | `test/fakes/` | An in-memory fake for every port, and a recording permission. |

## File ownership

One owner per file. A package edits only its own files; a Day 0 file changes only in a pull request that says it
changes the contract, reviewed before the packages that depend on it rebase. New files go in the owner's folder.

| Owner | Files |
| --- | --- |
| **Day 0** | `src/ports.ts`, `src/deps.ts`, `src/events.ts`, `src/stub.ts`, `src/domain/contract.ts`, `src/domain/errors.ts`, `src/domain/actions.ts`, `src/domain/plans.ts`, `src/plans/route.ts`, `src/ledger/*`, `src/permissions.ts`, `src/tools.ts`, `src/tools/*`, `src/tools-rpc.ts`, `src/plugin.ts`, `src/index.ts`, `src/options.ts`, `src/constants.ts`, `src/host-version.ts`, `src/redact.ts`, `src/skills.ts`, `src/version.ts`; `package.json` (`jelly`, `sources`, `opencode`); `test/fakes/*`, `test/support/*`, `test/unit/{actions,contract,errors,jelly,ledger,options,permissions,plans,registry,skills,host-version,source-contract}.test.ts`, `test/conformance/declaration.test.ts`, `test/host/*`, `test/pack/*`; `scripts/errors-doc.mjs`; `docs/v1-design.md`, `docs/errors.md` (generated), `AGENTS.md`. The kit files in `scripts/` and `test/support/` belong to the family kit, not to this repository. |
| **A. Auth** | `src/auth/*`; `test/unit/auth*.test.ts`, `test/host/auth*.test.ts`; `docs/auth.md`. |
| **B. Runtime transport** | `src/runtime/*` (Colab API client, the runtime protocol, the agent-only check and its probe snippet); `test/fake/colab-api.ts`, the proxy-in-front-of-jupyter harness, `test/unit/runtime*.test.ts`, `test/host/runtime*.test.ts`; the drift job's workflow file. |
| **C. Notebooks** | `src/notebooks/*` (nbformat model, `colab_find`, `colab_notebook`, `colab_edit`, `DriveSync`, the `drive.*` plans, the source secret screen); `test/fake/drive.ts`, `test/unit/notebook*.test.ts`. |
| **D. Execution** | `src/execution/*` (`colab_specs`, `colab_runtimes`, `colab_files`, `colab_execution`, `colab_run`, `colab_cancel`, `colab_upload`, `colab_download`, capture, write-back, the `runtime.create` and consumer `runtime.delete` plans); `test/unit/execution*.test.ts`, `test/host/execution*.test.ts`. |
| **E. Enterprise** | `src/enterprise/*` (`colab_jobs`, `colab_schedules`, `colab_pause`, the `job.*`, `schedule.*`, `runtime.stop` and Enterprise `runtime.delete` plans, `EnterpriseRuns`, the price table); `test/fake/vertex.ts`, `test/fake/gcs.ts`, `test/unit/enterprise*.test.ts`. |
| **F. Cost, cleanup, status** | `src/cost/*` (`colab_status`, `Release`, automation, budgets, hooks, `/colab-cleanup`), `src/rpc.ts`, `src/status.ts`, `src/tui/*`; `test/unit/cost*.test.ts`, `test/host/cost*.test.ts`; `docs/costs.md`. |
| **G. Sources, skills, docs** | `src/sources/*` (`colab_events_list`, `colab_runtimes_read`, `probe`); `test/conformance/sources.test.ts`, `npm run conformance`; `skills/*`; `README.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/jelly.md`, `docs/scripting.md`, `docs/safety.md`, `CHANGELOG.md` (each package adds its own `[Unreleased]` lines; G edits the rest). |

Shared tools cross packages through ports, not files: `colab_execution`, `colab_cancel` and `colab_download` are D's,
and call `deps.enterprise` (E) for a job or a GCS object and `deps.driveSync` (C) for a Drive notebook; the consumer
`runtime.delete` plan is D's and calls `deps.release` (F), the one release function.

## How a tool runs

1. `src/tools/spec.ts` parses the input against the contract (`INPUT_INVALID`), resolves the account
   (`ACCOUNT_UNKNOWN`, `ACCOUNT_REQUIRED`), and asks the handler for its ask metadata.
2. It asserts `colab.<tool>` **once**, on the resources `src/tools/resources.ts` gives: `<account>` for a read;
   `<account>:<operation>` for a change, plus `<account>:runtime:<id>` for a runtime-scoped call. Every assert except
   `colab.delete`'s offers Always for exactly those resources.
3. The handler runs. Before each provider read it calls `ctx.providerRead(operation)`, which asserts `colab.read` on
   `<account>:<operation>` once per operation and call.
4. A `ColabError` becomes `{ state, error, message, next }`; an abort becomes `CANCELLED`; a host permission denial
   propagates unchanged.

`colab_write` and `colab_delete` skip step 2: the plan route asserts `colab.write` / `colab.delete` on the plan's
`<account>:<operation>` after checking the binding and before taking the plan.

**`colab_run` asks once** (review LOW 4). The wrapper's one `colab.run` assert covers the execute operation and the
runtime. The pre-run and post-run probes, the watchdog's start and cancel requests and the session the run opens all
run under it; none asserts again. The host test H11 checks that a run produces exactly one ask, carrying the code
preview.

## The agent-only guarantee

Worded the same here, in the README, the skill and the `colab.run` note:

- **Guaranteed:** the plugin never puts a credential on a runtime; runs code only on runtimes it created; declines
  every credential request (`colab_request`, stdin); refuses any runtime where it has *observed* a credential or
  another client, for good.
- **Best effort:** detecting a credential or client that arrived and left between two probes, or one held in a form
  the probe has no marker for. The session nonce is not a secret: session names, nonce included, are listed by
  Jupyter and by Google's Colab MCP, and a client that opens a session with one of the plugin's session ids runs code
  in that kernel without a new session — a session without the nonce is foreign, and a client using one of the
  plugin's own sessions is seen only by the connections check, while attached. The probe shares the runtime with the
  agent's own code, which runs as root and may keep processes running after a run; it detects other clients' traces
  and accidents, not code written to hide from it. Only a release or a kernel restart ends such background processes;
  nothing else does.
- **Cannot see:** a secret the agent writes into code or uploads (screened, not prevented); what code reaches on the
  internet; Google-side mechanisms that leave no trace on the runtime (L15–L17).

## The review's last four notes, in the contract

| Note | Where |
| --- | --- |
| LOW 1: the nonce is not secret | `AgentOnlyCheck` and `RuntimeRecord.nonce` in `src/ports.ts`; the guarantee above. |
| LOW 2: the agent's root-level code can blind the probe | The guarantee's best-effort part above; `Calibration.probeKernel` records the probe kernel's id and execution count: the probe kernel starts at calibration, before any agent code, and is never restarted; a changed id, a dead kernel or a count that goes backwards is `RUNTIME_UNVERIFIED` and taints the runtime. |
| LOW 3: 5 s is too short for kernel start-up | Option `probeKernelStartSeconds` (60), a separate start budget at calibration; `probeTimeoutSeconds` (5) bounds each probe after. `Calibration.probeKernel` records `startMs`, `rttMs` and `ramBytes` for L2. |
| LOW 4: a run asks once | `runResources` in `src/domain/actions.ts`; the wrapper's single assert; "How a tool runs" above. |

## Open points the design did not settle

- **Codes Day 0 added** (not in design §12): `INPUT_INVALID`, `ACCOUNT_UNKNOWN`, `ACCOUNT_REQUIRED` (accounts need
  them), `NOT_IMPLEMENTED` (the stubs; gone by v0.1.0), `RULES_NOT_ADDED`, `TOOLS_NOT_REGISTERED`, `STATUS_UNAVAILABLE`
  (registration and status, as the family has) and `LEDGER_UNAVAILABLE` (the ledger's lock and files).
- **`colab_plan`'s input shape.** The design writes `colab_plan({ action, account?, … })`. Day 0 puts the action's own
  parameters under `params`, checked per action by the route, so an unknown or refused action answers its own code
  rather than a schema error.
- **Exposure.** Reads are Code Mode tools and tools RPC methods; changes are direct tools (gws's choice), so each change
  is one visible step. The design does not say which.
- **The icon.** The design's `opencode.vendor.mark: true` needs the vendor's permission (OD-30). Until then the package
  ships an original tile (a notebook and a run mark, no Google or Colab mark) and declares no `mark`.
- **Jelly's schema in CI.** The jelly test validates against Jelly's `PluginDeclarationSchema` only when an export of
  Jelly's contracts is at hand (`JELLY_CONTRACTS`); CI has none, so CI runs the family kit's checks and the access
  simulation only. The Day 0 pull request records the schema result.
- **Runtime ids.** The Colab API takes lowercase letters, digits and hyphens for `runtimeId`, so `oc-<ulid>` is written
  in lowercase.
- **Permission-only entries.** `colab.read` and `colab.probe` are declared with no tool of their own; Jelly confirms
  that is acceptable before release (else a real read-only tool carries `colab.read`, as `gws.read` does).
