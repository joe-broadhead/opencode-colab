# Colab for OpenCode

`@we-the-rebel-alliance/colab-plugin` connects OpenCode to Google Colab and to local Jupyter notebooks: find, read and
edit `.ipynb` files, run code on a Colab runtime, upload and download files, list runtime specs, Enterprise jobs and
schedules, and preview every change before committing it.

Notebook and runtime content is untrusted data. It is never followed as instructions and never used to choose a tool.

## Install

OpenCode `>=2.4.1 <2.5.0`; the tested release is 2.4.1.

```sh
opencode plugin add github:we-the-rebel-alliance/colab-plugin#v0.0.0
```

`v0.0.0` is the first release on plugin-contract v0.

## Sign in

The plugin holds one OpenCode integration per account alias: `colab` for `default`, `colab-<alias>` for any other.

1. Configure the accounts you want in `opencode.json`:

   ```json
   { "plugins": [{ "package": "github:we-the-rebel-alliance/colab-plugin#v0.0.0", "options": { "accounts": { "work": {}, "personal": {} } } }] }
   ```

2. Sign each alias in with `/connect` and choose Colab (work), or run
   `opencode auth login colab-work`. Enter a Google Desktop OAuth client, or set `oauthClient` in the account's profile.
3. Read `/colab` for the account states and the plugin's cost.

A profile can be empty (`{}`). Its fields are documented in [docs/accounts.md](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/accounts.md).

## Access levels

The `access` option is the ceiling for every method:

| Level | Reads (status, find, notebook, runtimes, events) | Writes and exports (edit, run, upload, download, plans, commits) |
| --- | --- | --- |
| `all` (default) | run | run |
| `ask-changes` | run | ask first |
| `read-only` | run | refused |

A method's `effect` only narrows that table. A commit of a non-local change over RPC additionally needs an answered
OpenCode ask or a host-signed action grant.

## Options

Options live under the plugin entry in `opencode.json`: `access`, `accounts`, the runtime caps, budgets, work
directory and the Enterprise defaults. Every option, its type and its default are in
[docs/configuration.md](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/configuration.md); an unknown option is refused with `OPTIONS_INVALID`.

## Capabilities

<!-- generated:capabilities -->
### Methods

| Method | Class | Accounts | Operations |
|---|---|---|---|
| `status` | read | none | — |
| `probe` | read | optional | — |
| `usage` | read | optional | `colaboratory.getSubscription`, `colaboratory.runtimes.list`, `colaboratory.runtimes.get`, `jupyter.kernels.list`, `jupyter.sessions.list`, `aiplatform.projects.locations.notebookRuntimes.list` |
| `specs` | read | optional | `colaboratory.runtimespecs.list`, `colaboratory.getSubscription`, `aiplatform.projects.locations.notebookRuntimeTemplates.list` |
| `runtimes` | read | optional | `colaboratory.runtimes.list`, `colaboratory.runtimes.get`, `jupyter.kernels.list`, `jupyter.sessions.list`, `aiplatform.projects.locations.notebookRuntimes.list` |
| `find` | read | optional | `drive.files.list`, `storage.objects.list` |
| `notebook` | read | optional | `drive.files.get`, `storage.objects.get`, `drive.revisions.list` |
| `files` | read | optional | `jupyter.contents.list` |
| `execution` | read | optional | `jupyter.kernels.list`, `jupyter.sessions.list`, `aiplatform.projects.locations.notebookExecutionJobs.get`, `storage.objects.list`, `storage.objects.get`, `aiplatform.projects.locations.notebookExecutionJobs.operations.list` |
| `jobs` | read | optional | `aiplatform.projects.locations.notebookExecutionJobs.list`, `aiplatform.projects.locations.notebookExecutionJobs.get` |
| `schedules` | read | optional | `aiplatform.projects.locations.schedules.list` |
| `events_list` | read | optional | `colab.ledger.list` |
| `runtimes_read` | read | optional | `colaboratory.runtimes.list`, `aiplatform.projects.locations.notebookRuntimes.list`, `colab.ledger.list` |
| `plan_write` | read | optional | `colaboratory.runtimes.list`, `colaboratory.runtimes.get`, `colaboratory.runtimespecs.list`, `colaboratory.getSubscription`, `aiplatform.projects.locations.notebookExecutionJobs.list`, `aiplatform.projects.locations.notebookExecutionJobs.get`, `aiplatform.projects.locations.notebookRuntimeTemplates.list`, `aiplatform.projects.locations.schedules.get`, `jupyter.kernels.list`, `jupyter.sessions.list`, `jupyter.contents.list`, `drive.files.list`, `drive.files.get`, `drive.revisions.list`, `storage.objects.list`, `aiplatform.projects.locations.notebookRuntimes.get` |
| `plan_delete` | read | optional | `colaboratory.runtimes.list`, `colaboratory.runtimes.get`, `colaboratory.runtimespecs.list`, `colaboratory.getSubscription`, `aiplatform.projects.locations.notebookExecutionJobs.list`, `aiplatform.projects.locations.notebookExecutionJobs.get`, `aiplatform.projects.locations.notebookRuntimeTemplates.list`, `aiplatform.projects.locations.schedules.get`, `jupyter.kernels.list`, `jupyter.sessions.list`, `jupyter.contents.list`, `drive.files.list`, `drive.files.get`, `drive.revisions.list`, `storage.objects.list`, `aiplatform.projects.locations.notebookRuntimes.get` |
| `edit` | write | optional | `notebook.local.edit` |
| `run` | write | optional | `jupyter.kernels.execute`, `colaboratory.runtimes.get`, `jupyter.kernels.list`, `jupyter.sessions.list`, `jupyter.contents.list` |
| `cancel` | write | optional | `jupyter.kernels.interrupt`, `aiplatform.projects.locations.notebookExecutionJobs.operations.cancel`, `aiplatform.projects.locations.notebookExecutionJobs.operations.list` |
| `upload` | write | optional | `jupyter.contents.save` |
| `download` | export | optional | `jupyter.contents.get`, `drive.files.get`, `storage.objects.get` |
| `pause` | write | optional | `aiplatform.projects.locations.schedules.pause`, `aiplatform.projects.locations.schedules.get` |
| `write` | write | optional | `colaboratory.runtimes.create`, `colaboratory.runtimes.delete`, `aiplatform.projects.locations.notebookRuntimes.stop`, `aiplatform.projects.locations.notebookRuntimes.delete`, `aiplatform.projects.locations.notebookExecutionJobs.create`, `aiplatform.projects.locations.notebookExecutionJobs.delete`, `aiplatform.projects.locations.schedules.create`, `aiplatform.projects.locations.schedules.patch`, `aiplatform.projects.locations.schedules.resume`, `aiplatform.projects.locations.schedules.delete`, `drive.files.create`, `drive.files.update`, `drive.revisions.update` |
| `delete` | delete | optional | `colaboratory.runtimes.create`, `colaboratory.runtimes.delete`, `aiplatform.projects.locations.notebookRuntimes.stop`, `aiplatform.projects.locations.notebookRuntimes.delete`, `aiplatform.projects.locations.notebookExecutionJobs.create`, `aiplatform.projects.locations.notebookExecutionJobs.delete`, `aiplatform.projects.locations.schedules.create`, `aiplatform.projects.locations.schedules.patch`, `aiplatform.projects.locations.schedules.resume`, `aiplatform.projects.locations.schedules.delete`, `drive.files.create`, `drive.files.update`, `drive.revisions.update` |
| `cleanup` | write | optional | `colaboratory.runtimes.delete`, `aiplatform.projects.locations.notebookRuntimes.delete`, `jupyter.contents.list`, `colaboratory.runtimes.get` |

### Sources

| Source | Kind | Reads or output | Method | Cost |
|---|---|---|---|---|
| `colab.runs` | events | `x-colab/run` | `events_list` | free |
| `colab.runtimes` | snapshot | `table` | `runtimes_read` | free |

### Actions

None.

### Bus events

`rpc.colab.changed`
<!-- /generated:capabilities -->

## Errors

<!-- generated:errors -->
| Code | Meaning |
|---|---|
| `NEEDS_SIGN_IN` | the account is not signed in |
| `SCOPE_MISSING` | the call needs a scope the person has not confirmed |
| `ACCOUNT_REQUIRED` | the plugin serves several accounts and the call names none |
| `ACCOUNT_UNKNOWN` | the call names an alias the plugin does not serve |
| `ACCOUNT_MISMATCH` | the item belongs to another account |
| `CURSOR_INVALID` | the cursor is malformed, or belongs to another source, account or scope |
| `CURSOR_EXPIRED` | the provider no longer keeps the history the cursor names |
| `RATE_LIMITED` | the provider asked the plugin to slow down |
| `BUDGET_EXCEEDED` | the read would cost more than the person allows |
| `SOURCE_DISABLED` | the person turned this source or action off |
| `TOO_LARGE` | the answer is larger than the source's maxBytes |
| `INPUT_INVALID` | the input does not match the method's schema |
| `SOURCE_UNKNOWN` | the plugin declares no such source |
| `SCHEMA_VIOLATION` | an answer does not keep the contract's shape |
| `PERMISSION_DENIED` | the person's grant does not cover the call |
| `PLAN_INVALID` | the plan is missing, or belongs to another method |
| `PLAN_USED` | the plan was already used by an earlier commit |
| `GRANT_INVALID` | the action grant did not verify, or was already spent |
| `HOST_UNTESTED` | OpenCode is outside the plugin's tested range |
| `OPTIONS_INVALID` | the plugin's options do not match their schema |
| `UNAVAILABLE` | the provider could not be reached |
<!-- /generated:errors -->

## Troubleshooting

- **`status` says `needs_sign_in`.** Run `/connect` and choose the Colab integration for that alias, or
  `opencode auth login colab` for `default` and `opencode auth login colab-<alias>` for another alias.
  `/colab-doctor` prints one small check per account.
- **`HOST_UNTESTED`.** The running OpenCode is outside `>=2.4.1 <2.5.0`. Install a tested release, or set
  `allowUntestedHost: true` for an untested one.
- **A write is refused with `PERMISSION_DENIED`.** The `access` level is `read-only`, the account profile is `read`, or an
  RPC commit has no answered ask or action grant.
- **A plan is refused with `PLAN_INVALID` or `PLAN_USED`.** Plans last 15 minutes and commit once; plan again and pass
  the new `planId`.
- **`/colab` is empty or unavailable.** Check that the plugin entry is in `opencode.json` and that `opencode plugin list`
  shows it. The rich status is also the `usage` method.

## Docs

- [plugin-contract](https://github.com/we-the-rebel-alliance/plugin-contract) — the manifest, methods, sources, errors and
  conformance kit this plugin implements
- [Capabilities](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/capabilities.md)
- [Accounts](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/accounts.md)
- [Configuration](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/configuration.md)
- [Architecture](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/architecture.md)
- [Security](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/security.md)
- [Automations](https://github.com/we-the-rebel-alliance/colab-plugin/blob/master/docs/automations.md)
- [Contributing](CONTRIBUTING.md)
