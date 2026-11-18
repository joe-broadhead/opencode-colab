# v0.1.0: the Day 0 contract and file ownership

The plugin's v0.1.0 is built in packages A–G on top of a Day 0 contract, so the packages build in parallel without
editing each other's files. This page is the contract's map: what Day 0 holds, who owns each file, and the decisions
Day 0 made where the design left a gap. The design itself (decisions, safety, cost, tests, live checks L1–L17) is the
reviewed design document; this page restates only what a package needs to build against.

## What Day 0 holds

| Piece | File | What it fixes |
| --- | --- | --- |
| Ports | `src/ports.ts` | Every boundary: Colab API, the runtime protocol (`openSession`, `execute`, `interrupt`, `watchdog`, `files`, `kernels`, `sessions`), the agent-only check, Vertex (lists across pages, `Listed`), Drive, GCS, auth `token(account, scopes)`, the ledger, the plan store, `RunEvents` subscribe, the clock; and the seams between packages (`Release`, `Budget`, `EnterpriseRuns`, `Prices`, `DriveSync`, `NotebookStore`). |
| Deps | `src/deps.ts` | One object with every port, built from each package's factory. Tools receive it; nothing imports another package's module. Two factories are optional, so a package adds them in its own files: F's `createBudget` (until then every budget check is `ok`), the `prices` E's `createEnterprisePorts` returns (until then nothing is priced), and the `notebooks` C's factory returns (until then NOT_IMPLEMENTED); C may rename `createDrivePorts` to `createNotebookPorts`. |
| Contract | `src/domain/contract.ts` | The 20 tools' input schemas and result shapes; every result is `{ state, …, error?, message?, next?, warnings? }`; `PLAN_PARAMS` per plan action. |
| Errors | `src/domain/errors.ts` | The one error table (design §12, plus the Day 0 additions below), the warnings, the source-code mapping, `ColabError`, and `docs/errors.md` generated from it. |
| Actions | `src/domain/actions.ts` | The 20 tools with class, owner and exposure; the `colab.*` action names; `colab.read` and `colab.probe` as permission-only reads; `colab.cleanup`; the operation ids; the §7.1 change table; the §7.2 plan actions with category, backend, owner and operation. |
| Plan store and routing | `src/domain/plans.ts`, `src/plans/route.ts` | Single-use plans, 300 s, bound to session, agent and account; `colab_plan` → `colab_write` / `colab_delete`, refusals, category checks, the commit's one assert. |
| Ledger | `src/ledger/store.ts` | `$XDG_STATE_HOME/opencode-colab/ledger/`: copy-on-write JSON per runtime and run, `events.jsonl`, a cross-process lock, pruning after `ledgerDays`. |
| Secret screen | `src/redact.ts` | `screenSecrets(text)` → `{ text, matches, found, kinds }` and `WITHHELD`: the one screen for package C (sources, outputs, Drive previews) and package E (job sources). No hex exemption beyond a 64-hex run after `sha256:`. |
| Default rules | `src/permissions.ts` | The `access` → rules block: `colab.*` gets the change effect; the 12 read tools, `colab.read` and `colab.probe` allow; the 8 change tools get the change effect; `colab.cleanup` asks, and is denied at `read-only`. |
| Registry | `src/tools/registry.ts`, `src/tools/spec.ts`, `src/tools/resources.ts`, `src/tools/types.ts` | Each tool's handler from its owner; the one wrapper that parses, resolves the account, asserts `colab.<tool>` once and maps errors to results. |
| Declarations | `package.json` `jelly`, `sources` | 22 jelly entries (20 tools and 2 permission-only reads); the `colab.runs` and `colab.runtimes` sources. |
| Fakes | `test/fakes/` | An in-memory fake for every port, and a recording permission. |

## File ownership

One owner per file. A package edits only its own files; a Day 0 file changes only in a pull request that says it
changes the contract, reviewed before the packages that depend on it rebase. New files go in the owner's folder, named
so they match only the owner's patterns below. `test/unit/docs.test.ts` checks that every file under `src/` and
`test/` matches exactly one owner, and that no two owners' patterns overlap.

Fakes live in one folder, `test/fakes/`. `test/fakes/index.ts` is Day 0's and is not extended: a package that needs a
richer double (a loopback Colab API, the proxy in front of a real Jupyter server, Vertex, GCS, Drive) adds
`test/fakes/<package>-*.ts`, named after its `src/` folder, and subclasses or composes the Day 0 fakes there.

| Owner | Files |
| --- | --- |
| **Day 0** | `src/ports.ts`, `src/deps.ts`, `src/events.ts`, `src/stub.ts`, `src/domain/*`, `src/plans/*`, `src/ledger/*`, `src/permissions.ts`, `src/tools.ts`, `src/tools/*`, `src/tools-rpc.ts`, `src/plugin.ts`, `src/index.ts`, `src/options.ts`, `src/constants.ts`, `src/host-version.ts`, `src/redact.ts`, `src/skills.ts`, `src/version.ts`; `test/fakes/index.ts`; `test/unit/{actions,contract,docs,errors,host-version,jelly,ledger,options,permissions,plans,plugin,redact,registry,skills,source-contract}.test.ts`; `test/conformance/declaration.test.ts`; `test/host/harness.ts`, `test/host/isolate.ts`, `test/host/route-fetch.ts`, `test/host/scratch.ts`, `test/host/plugin.test.ts`; `test/pack/pack.test.ts`; `test/fixtures/tool-registry.json`; `package.json` (the `jelly`, `sources` and `opencode` keys); `scripts/errors-doc.mjs`; `docs/v1-design.md`, `docs/errors.md` (generated); `AGENTS.md`. |
| **Family kit** | `test/support/jelly-kit.ts`, `test/support/jelly-settings.ts`, and the kit files in `scripts/` pinned by `scripts/check-copies.mjs`: copies, changed in every plugin at once. |
| **A. Auth** | `src/auth/*`; `test/fakes/auth-*.ts`, `test/unit/auth*.test.ts`, `test/host/auth*.test.ts`; `docs/auth.md`. |
| **B. Runtime transport** | `src/runtime/*` (the Colab API client, the runtime protocol, the agent-only check and its probe snippet); `test/fakes/runtime-*.ts` (the loopback Colab API, the proxy-in-front-of-jupyter harness), `test/unit/runtime*.test.ts`, `test/host/runtime*.test.ts`; the drift job's workflow file. |
| **C. Notebooks** | `src/notebooks/*` (the nbformat model, find, notebook, edit, DriveSync, the drive plans, the source secret screen); `test/fakes/notebooks-*.ts` (Drive), `test/unit/notebooks*.test.ts`. |
| **D. Execution** | `src/execution/*` (specs, runtimes, files, execution, run, cancel, upload, download, capture, write-back, the runtime.create and consumer runtime.delete plans); `test/fakes/execution-*.ts`, `test/unit/execution*.test.ts`, `test/host/execution*.test.ts`. |
| **E. Enterprise** | `src/enterprise/*` (jobs, schedules, pause, the job, schedule, runtime.stop and Enterprise runtime.delete plans, EnterpriseRuns, the price table); `test/fakes/enterprise-*.ts` (Vertex, GCS), `test/unit/enterprise*.test.ts`. |
| **F. Cost, cleanup, status** | `src/cost/*` (status, Release, automation, budgets, hooks, the cleanup command), `src/rpc.ts`, `src/status.ts`, `src/tui/*`; `test/fakes/cost-*.ts`, `test/unit/cost*.test.ts`, `test/host/cost*.test.ts`; `docs/costs.md`. |
| **G. Sources, skills, docs** | `src/sources/*` (events_list, runtimes_read, probe); `test/fakes/sources-*.ts`, `test/unit/sources*.test.ts`, `test/conformance/sources.test.ts`, `npm run conformance`; `skills/*`; `README.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/jelly.md`, `docs/scripting.md`, `docs/safety.md`, `CHANGELOG.md` (each package adds its own `[Unreleased]` lines; G edits the rest). |

Shared tools cross packages through ports, not files: `colab_execution`, `colab_cancel` and `colab_download` are D's,
and call `deps.enterprise` (E) for a job or a GCS object and `deps.driveSync` (C) for a Drive notebook; the consumer
`runtime.delete` plan is D's and calls `deps.release` (F), the one release function.

## How a tool runs

1. `src/tools/spec.ts` parses the input against the contract (`INPUT_INVALID`), resolves the account
   (`ACCOUNT_UNKNOWN`, `ACCOUNT_REQUIRED`), refuses a change tool or `colab_plan` on an account with `access: "read"`
   (`ACCOUNT_READ_ONLY`, before any assert or network call; design §4), and asks the handler for its ask metadata.
2. It asserts `colab.<tool>` **once**, on the resources `src/tools/resources.ts` gives: `<account>` for a read;
   `<account>:<operation>` for a change, plus `<account>:runtime:<id>` for a runtime-scoped call. Every assert except
   `colab.delete`'s offers Always for exactly those resources.
3. The handler runs. Before each provider read it calls `ctx.providerRead(operation)`, which asserts `colab.read` on
   `<account>:<operation>` once per operation and call. Before writing a workspace file, writing outside the project,
   or reading a file to upload, it calls `ctx.hostAssert` with OpenCode's own `edit`, `external_directory` or `read`
   (never a `colab.*` action).
4. A `ColabError` becomes `{ state, error, message, next }`; an abort becomes `CANCELLED`; a host permission denial
   propagates unchanged.

`colab_write` and `colab_delete` skip steps 1's account and 2: the plan route refuses a plan whose account is now read
(`ACCOUNT_READ_ONLY`), then asserts `colab.write` / `colab.delete` on the plan's
`<account>:<operation>` after checking the binding and before taking the plan.

**`colab_run` asks once** (review LOW 4). The wrapper's one `colab.run` assert covers the execute operation and the
runtime. The pre-run and post-run probes, the watchdog's start and cancel requests and the session the run opens all
run under it; none asserts again. The host test H11 checks that a run produces exactly one ask, carrying the code
preview.

## The agent-only guarantee

Word for word here, in the README and in the `opencode-colab` skill; `test/unit/docs.test.ts` pins the three tiers in
all three. The `colab.run` note in `jelly.tools` is its one-line summary ("… (best effort)").

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

## Package checklists

What each package proves beyond design §16's must-prove column, from the Day 0 review:

- **A.** `registerAuth` receives `Deps` (`AuthEnv.deps`, A's field) for the doctor's `print(1)`: the ledger's
  untainted runtimes of ours, `deps.check.probe(…, { fresh: true })` before the print, the runtime protocol with
  `allowStdin: false` in an `oc-<nonce>-doctor` session, and `deps.auth` for its token. The sign-in form answers
  `AUTH_CLIENT_INVALID`, `AUTH_REDIRECT_INVALID`, `AUTH_REDIRECT_MISMATCH` and `AUTH_WRITE_UNCONFIRMED`, not
  `INPUT_INVALID`.
- **B.** Proxy-token refresh and the runtime URL's host allow-list (design §15.1's auth bullet) are B's to prove, with
  H6: the proxy token and `connectionInfo.url` come from B's `runtimes.get`; A supplies only the OAuth token.
- **C.** Calls `ctx.hostAssert` unconditionally for `edit` (and `external_directory` outside the project) in
  `colab_edit`, with the H8 host test on all six hosts; returns `notebooks` (`NotebookStore`, sharing `colab_edit`'s
  per-path lock) from its factory; calls `read` before its Drive reads in `DriveSync.pull`; counts kept revisions
  with `keptRevisions` at preview; uses `generateId` for a create that can be retried; screens with `screenSecrets`.
- **D.** Write-back goes through `deps.notebooks.mergeRun` after `hostAssert({ action: "edit" })`; `colab_download`
  and `colab_upload` assert `edit`/`external_directory` and `read` through `hostAssert`; passes `ctx.providerRead`
  to `DriveSync.pull` and `EnterpriseRuns`.
- **E.** Writes `RunRecord.estimatedUsd` at the `job.create` commit (the preview's estimate), and reads the budget's
  `limit` and `unit` (the deprecated `limitUsd` goes once it does).
- **E.** Calls `deps.budget.check` at the preview and the commit of `job.create`, `schedule.create` and
  `schedule.resume` (`refuse` → `BUDGET_REACHED`, `warn` → `BUDGET_WARN`); returns `prices` from
  `createEnterprisePorts`; records a job's create LRO on `RunRecord.operation` and falls back to `listJobOperations`;
  calls `read` before each provider read inside `EnterpriseRuns`; screens job sources with `screenSecrets`.
- **F.** The automation never releases a runtime whose account has `access: "read"`. It is listed in `attention`.
  `/colab-cleanup` may offer it, because the person confirms each release in a prompt that names the account.
  (Recorded from the package F review; the proposal to release read accounts' runtimes was rejected.)
- **F.** `registerCost` returns `{ dispose, problems }`: the hooks this host refused (`idle` for
  `experimental.idle`); `src/plugin.ts` words each as one sentence in status's problems. `createBudget(env, prices)`
  receives E's price table, so the day's Enterprise runs are priced from `RunRecord.estimatedUsd`; `Budget.check`
  answers `spent`, `limit` and `unit` (`usd` or `runtime-hours`). `colab_status` carries the last sweep's `attention`.
- **F.** `colab.cleanup` at `read-only`: the default rule denies it (`src/permissions.ts`, as Jelly's namespace rule
  does), and `/colab-cleanup` at `read-only` lists what costs money and takes no action, asserting nothing (design
  §8.5). At `all` and `ask-changes` each action is a person-only ask.
- **G.** The `opencode-colab` skill and the README show `colab_plan({ action, account?, params })`, with the action's
  own parameters under `params`, and the commit with only `{ planId }`. The README and the skill keep the guarantee
  word for word (the docs test).

## Open points the design did not settle

- **Codes Day 0 added** (not in design §12): `AUTH_CLIENT_INVALID`, `AUTH_REDIRECT_INVALID`,
  `AUTH_REDIRECT_MISMATCH`, `AUTH_WRITE_UNCONFIRMED` (gws's sign-in form codes, for package A), `ACCOUNT_READ_ONLY`
  (an account with `access: "read"` changes nothing), `INPUT_INVALID`, `ACCOUNT_UNKNOWN`, `ACCOUNT_REQUIRED` (accounts need
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
