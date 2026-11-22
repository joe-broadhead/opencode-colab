# Colab for OpenCode

Lets OpenCode agents edit Jupyter notebooks, run them on [Google Colab](https://colab.research.google.com) CPUs, GPUs
and TPUs, or as Colab Enterprise jobs, and bring the results back as files the agent can read and chart.

Unofficial; not affiliated with Google. Google and Colab are trademarks of Google LLC; this unofficial plugin is not
endorsed by Google.

> **Not yet released.** This is v0.0.1, built in packages on top of a fixed contract. There is no release tag. Until every
> package has landed, a tool whose package has not answers `NOT_IMPLEMENTED`. An install that is not a tagged release
> answers `NOT_RELEASED` and sends nothing to Google. None of the live checks against Google (L1–L17,
> [below](#live-checks-not-yet-run)) has run: everything Google-facing is tested against fakes built from Google's
> documentation. **L1 decides whether running code on consumer Colab ships enabled.**

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7, 2.3.0, 2.3.1 and 2.3.2. Outside that range the plugin does
  not load, unless you set [`allowUntestedHost`](docs/configuration.md).
- macOS or Linux.
- A Google account. GPUs need Colab Pro, Pro+ or Pay-As-You-Go compute units; Colab Enterprise needs a Google Cloud
  project with billing.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-colab#v0.0.1
```

Run `opencode reload`, or restart OpenCode. Then run `/colab-status` in a session, and sign in with `/connect` →
Colab. [Sign-in and accounts](docs/auth.md) covers the scopes each account requests and the headless modes.

## What the agent can do

| Tool | What it does |
| --- | --- |
| `colab_status`, `colab_specs`, `colab_runtimes`, `colab_find`, `colab_notebook`, `colab_files`, `colab_execution`, `colab_jobs`, `colab_schedules` | Read accounts, specs, runtimes, notebooks, runtime files, runs, jobs and schedules. |
| `colab_plan` | Preview a costly or destructive change (a runtime, a job, a schedule, a Drive push, a release) and get a single-use plan. |
| `colab_write`, `colab_delete` | Commit a plan. |
| `colab_edit` | Edit a local notebook. |
| `colab_run`, `colab_cancel` | Run code or cells on a runtime the plugin created; interrupt it. |
| `colab_upload`, `colab_download` | Move files between the workspace and a runtime, Drive or Cloud Storage. |
| `colab_pause` | Pause an Enterprise schedule. |
| `colab_events_list`, `colab_runtimes_read` | The `colab.runs` and `colab.runtimes` sources, for scripts and consumers such as Memory. |

Notebooks are local `.ipynb` files: Drive and Colab Enterprise are places a notebook is pulled from, pushed to or run
on. Every rich output (a plot, an HTML table, JSON) is saved under `.colab/runs/<runId>/`, so the agent opens a plot
by its path and hands a table to a charts tool by its path.

### A change is a plan, then a commit

A new runtime, a release, an Enterprise job or schedule, and a Drive push or trash each take two steps. `colab_plan`
takes the action, the account (optional) and the action's own parameters under `params`, and returns a preview and a
single-use `planId`, valid for 5 minutes; `colab_write` or `colab_delete` commits it with only that id.

```text
colab_plan({ "action": "runtime.create", "params": { "spec": { "variant": "VARIANT_GPU", "shape": "SHAPE_STANDARD", "accelerator": "T4" } } })
colab_write({ "planId": "<the planId colab_plan returned>" })
```

Running code on a runtime of the plugin's own is a direct tool, `colab_run`, whose ask shows the code.

## Runtimes are the agent's alone

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

Runtimes the plugin creates are named `oc-…`. Other clients, Google's own Colab MCP server included, must not use them.
How the checks work, and what each can and cannot see: [Safety](docs/safety.md).

## Permissions

The `access` option generates the default rules: `all` (the default) runs every tool without asking, code included, as
with `bash`; `ask-changes` asks before every change, and `colab_run`'s ask shows the code; `read-only` runs reads and
previews only. Reads never ask, including the provider reads they make (`colab.read`) and the source probe
(`colab.probe`). `colab_delete` never offers "always".

**A named account is read-only until you set its `access` to `write`.** With no `accounts` option there is one
account, `default`, at read and write; every account you name in `accounts` starts at `read`, and every change tool and
`colab_plan` refuse it with `ACCOUNT_READ_ONLY` until `accounts.<alias>.access` is `write`.

## Costs

Colab spends your compute units; Colab Enterprise bills your Cloud project. The plugin bounds both: an accelerator
allow-list (`NONE`, `T4`, `L4`), one runtime of its own at a time, a watchdog that interrupts a run at its time limit
even with OpenCode closed, Enterprise jobs with a compute cost cap ($5) and a one-hour limit, schedules that must end
and never overlap, and — at `access: all` — the release of an idle runtime of its own after 20 minutes, after
downloading `/content/outputs`. [Costs](docs/costs.md) has the facts and the rates.

## Sources

Two sources for the [source contract](https://github.com/we-the-rebel-alliance/source-contract) (v0.3.0), read through
the tools RPC (`google-colab.tools`) by a consumer that keeps the cursor:

| Source | Kind | What it lists |
| --- | --- | --- |
| `colab.runs` | events (`x-colab/run`) | One event per finished run or Enterprise job this plugin started, from the plugin's local ledger: no Google call, free. The title is the plugin's own words ("Ran 6 cells of analysis.ipynb on T4 GPU — failed (KERNEL_DIED), 42 s"); no cell text, output or link. |
| `colab.runtimes` | snapshot (`list`) | The account's runtimes now, at most 50: the plugin's own first, tainted ones marked, Enterprise ones with $/h. One listing call to Google, free. |

- `colab.runs` is owned by this computer's user, since the ledger is local; `colab.runtimes` by the signed-in Google
  account.
- A run is listed when its end is recorded, so a run lasting hours, or a job whose end the plugin observes late, is
  listed then, behind nothing. Each run is listed once.
- The ledger keeps `ledgerDays` (90): a cursor older than that answers one `gap: expired`, then everything kept.
- `colab.jobs` (every Enterprise job, the plugin's or not) is not shipped until live check L13 establishes how long
  Google keeps execution jobs.

The details, and every limit: [Scripting](docs/scripting.md#sources) and [Safety](docs/safety.md#known-limits).

## Known limits

The full list, with where each comes from, is in [Safety](docs/safety.md#known-limits). In short:

- The checks on a runtime are best effort past what they observe (the three tiers above); the agent's own code runs as
  root on the runtime.
- A run's output stream does not outlive the OpenCode process: the code keeps running until it ends or its time limit
  interrupts it, and the run then reads `detached`.
- The watchdog bounds a run, not a runtime's lifetime, and cannot interrupt C code that ignores signals.
- Google publishes no per-accelerator compute-unit rate and no balance API, so consumer costs are counted in
  runtime-hours.
- Enterprise jobs have no cancel method; `colab_cancel` cancels the create operation, and whether that stops a running
  job is live check L11.
- Every Google behaviour below that a live check has not confirmed is an assumption from Google's documentation.

## Live checks not yet run

| # | What it decides |
| --- | --- |
| **L1** | **The gate:** whether a third-party OAuth client gets `colaboratory` consent and can create runtimes. If not, the `colab` backend ships as notebook editing only (`COLAB_API_UNAVAILABLE`), and runs need an Enterprise account. |
| L2 | Hidden-path visibility, the baseline connection count, the runtime URL's host, token refresh mid-run, ranged and chunked file transfers. |
| L3 | Whether Vertex's notebook methods accept `aiplatform` + `devstorage.read_only` instead of `cloud-platform`. |
| L4 | That the runtime proxy does not re-check the token's scope. |
| L5 | The `FAILED_PRECONDITION` reasons for capacity, usage and runtime count. |
| L6 | That output is not replayed to a new connection. |
| L7, L7b, L7c | Colab's idle release of an API-created runtime, its compute-unit burn, and whether a running one is reclaimed. |
| L8, L8b | Drive: the notebook MIME type, `drive.file` visibility, revisions, and a push while the notebook is open in Colab. |
| L9 | That a declined `colab_request` returns within a second. |
| L10 | Enterprise jobs: the direct-source size limit, the output layout, the time limit and the default compute. |
| L11 | Whether cancelling a job's create operation, or deleting the job, stops it. |
| L12 | Template idle shutdown, and a stopped runtime's disk billing. |
| L13 | How long Google keeps execution jobs: decides `colab.jobs`. |
| L14 | Jelly's sign-in with its own client, and the verification class of `colaboratory`. |
| L15, L16, L17 | Other clients reaching `oc-` runtimes; Drive automount on API-created runtimes; the runtime's metadata server and ephemeral credentials. |

## Configure

See [Configuration](docs/configuration.md).

## Troubleshooting

Every error reads `CODE: What happened. Next step: What to do.` The codes, with their meaning and next step, are in
[Errors](docs/errors.md). Run `/colab-status` first: it names the next step. `/colab-doctor` checks the sign-in and the
APIs.

## Uninstall

```sh
opencode plugin remove github:joe-broadhead/opencode-colab#v0.0.1
```

## Links

- [Configuration](docs/configuration.md), [Sign-in and accounts](docs/auth.md), [Safety](docs/safety.md),
  [Costs](docs/costs.md), [Errors](docs/errors.md), [Scripting](docs/scripting.md), [In Jelly](docs/jelly.md)
- Contributors: [Architecture](docs/architecture.md), [the Day 0 contract and file ownership](docs/v1-design.md),
  [Contributing](CONTRIBUTING.md), [Security](SECURITY.md)
