# Colab for OpenCode

Lets OpenCode agents edit Jupyter notebooks, run them on [Google Colab](https://colab.research.google.com) CPUs, GPUs
and TPUs, or as Colab Enterprise jobs, and bring the results back as files the agent can read and chart.

Unofficial; not affiliated with Google. Google and Colab are trademarks of Google LLC; this unofficial plugin is not
endorsed by Google.

> **Not yet released.** This is v0.0.1 before its first release: the Day 0 contract. The plugin registers its twenty
> tools, its default rules and its status, but every tool answers `NOT_IMPLEMENTED` until its package lands. Nothing
> calls Google yet.

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

Run `opencode reload`, or restart OpenCode. Then run `/colab-status` in a session.

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
| `colab_events_list`, `colab_runtimes_read` | The `colab.runs` and `colab.runtimes` sources. |

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

## Permissions

The `access` option generates the default rules: `all` (the default) runs every tool without asking, code included, as
with `bash`; `ask-changes` asks before every change, and `colab_run`'s ask shows the code; `read-only` runs reads and
previews only.

## Configure

See [Configuration](docs/configuration.md).

## Troubleshooting

Every error reads `CODE: What happened. Next step: What to do.` The codes, with their meaning and next step, are in
[Errors](docs/errors.md). Run `/colab-status` first: it names the next step.

## Uninstall

```sh
opencode plugin remove github:joe-broadhead/opencode-colab#v0.0.1
```

## Links

- [Configuration](docs/configuration.md), [Errors](docs/errors.md), [Scripting](docs/scripting.md),
  [In Jelly](docs/jelly.md), [Costs](docs/costs.md)
- Contributors: [Architecture](docs/architecture.md), [the Day 0 contract and file ownership](docs/v1-design.md),
  [Contributing](CONTRIBUTING.md), [Security](SECURITY.md)
