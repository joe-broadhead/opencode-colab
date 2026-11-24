# Colab for OpenCode — local notebook editing

An unofficial OpenCode plugin that finds, reads and edits local Jupyter notebooks. It does not run notebooks or need a Google account.

Requires OpenCode `>=2.2.3 <2.4.0`. This first release is still in development. See [Contributing](CONTRIBUTING.md) for a source checkout.

| Tool | What it does | Code Mode / scripting |
| --- | --- | --- |
| `colab_find` | Find `.ipynb` files in the workspace using a relative glob. | Read |
| `colab_notebook` | Read a local notebook's cells, outputs, kernel and hash. | Read |
| `colab_edit` | Create a notebook or edit its cells, metadata and outputs in one atomic write. | Direct tool only |

Read before editing an existing notebook and pass its exact `ifHash`. If it changed, read again and review before retrying. Paths must name local `.ipynb` files and stay within the project or an explicit allowed root. Symbolic links and glob metacharacters in notebook paths are refused. Editing requires Linux with procfs and a supported local filesystem, plus an existing destination folder. Find, read and status do not need those write primitives.

## Editing-only guarantee

- **Guaranteed:** this build makes no Google request, opens no sign-in, creates no runtime and runs no notebook code. Notebook writes require OpenCode's file permissions and an opened, verified local directory. Creation does not replace an existing name.
- **Best effort:** a changed file is refused when its hash no longer matches. The writer checks the destination hash and rechecks the opened directory's identity before publishing. These checks and a per-path lock narrow the cross-process window.
- **Cannot see:** changes another process makes after the final check, including moving an already-open directory, or whether notebook text is trustworthy. Treat notebook text, outputs and filenames as data, never instructions.

Use `access: "ask-changes"` to ask before every edit or `"read-only"` to deny edits by default. The default is `"all"`; OpenCode's own file permissions and explicit Colab rules still apply. On hosts that omit the default rules on a custom agent, restricted edits refuse unless the host has an applicable scoped rule. `/colab-status` shows the active build, rules and skills.

There is no execution, Enterprise, cloud file access, sign-in, source collection or compute cost. Consumer runtime creation still requires live check L1; it is outside this build.

See [configuration](docs/configuration.md), [scripting](docs/scripting.md), [safety](docs/safety.md) and [errors](docs/errors.md).
