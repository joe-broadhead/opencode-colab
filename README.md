# Colab for OpenCode

Lets OpenCode agents edit Jupyter notebooks, run them on [Google Colab](https://colab.research.google.com) CPUs, GPUs
and TPUs, or as Colab Enterprise jobs, and bring the results back as files the agent can read and chart.

Unofficial; not affiliated with Google. Google and Colab are trademarks of Google LLC; this unofficial plugin is not
endorsed by Google.

> **Not yet released.** This is v0.0.1 before its first release: the repository scaffold. The plugin registers its
> default rules and its status, and has no tools yet. Nothing calls Google.

## Requirements

- OpenCode `>=2.2.3 <2.4.0`, tested on 2.2.3, 2.2.4, 2.2.5, 2.2.6, 2.2.7 and 2.3.0. Outside that range the plugin does
  not load, unless you set [`allowUntestedHost`](docs/configuration.md).
- macOS or Linux.
- A Google account. GPUs need Colab Pro, Pro+ or Pay-As-You-Go compute units; Colab Enterprise needs a Google Cloud
  project with billing.

## Install

```sh
opencode plugin add github:joe-broadhead/opencode-colab#v0.0.1
```

Run `opencode reload`, or restart OpenCode. Then run `/colab-status` in a session.

## Permissions

The `access` option generates the default rules: `all` (the default) runs every tool without asking, code included, as
with `bash`; `ask-changes` asks before every change; `read-only` runs reads and previews only.

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
- Contributors: [Architecture](docs/architecture.md), [Contributing](CONTRIBUTING.md), [Security](SECURITY.md)
