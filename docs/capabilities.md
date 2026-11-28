# Capabilities

The plugin has two sources, no actions, one bus event and 24 methods. Every method is reachable as an agent tool, in
Code Mode and over RPC under the id `colab`.

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
| `mcp:colab_enterprise_get_notebook_runtime` | read | optional | — |
| `mcp:colab_enterprise_list_notebook_runtime_templates` | read | optional | — |
| `mcp:colab_enterprise_list_notebook_runtimes` | read | optional | — |
| `mcp:get_notebook_execution_schedule` | read | optional | — |
| `mcp:get_operation` | read | optional | — |
| `mcp:list_notebook_execution_schedules` | read | optional | — |
| `mcp:notebook_execution_get_job` | read | optional | — |
| `mcp:notebook_execution_list_jobs` | read | optional | — |
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

## The sources

- **`colab.runs`** reads the plugin's own ledger: one event per finished consumer run or Enterprise job, with the
  backend, state, error code and accelerator as labels. It needs no sign-in. The cursor is bound to the account.
- **`colab.runtimes`** is a snapshot table of the account's Colab or Enterprise runtimes: spec, state, whether the plugin
  created it, taint, price when the dated table knows it, and idle shutdown.

## The methods

- **Reads.** `status` is the contract's short answer; `usage` is the rich product status (`/colab` reads it); `probe`
  names the owner; `specs`, `runtimes`, `find`, `notebook`, `files`, `execution`, `jobs` and `schedules` read the
  provider; `events_list` and `runtimes_read` answer the sources.
- **Plans.** `plan_write` and `plan_delete` preview a change and answer `{ method, output, changes, trust }`; the
  register mints the `planId`. They write nothing.
- **Commits.** `write` and `delete` take only `{ planId }`, read the stored plan and re-check what the preview showed.
- **Changes.** `edit` edits a local notebook atomically; `run` executes code or cells on a runtime the plugin created;
  `cancel` interrupts a run or cancels a job; `upload` and `download` move files; `pause` pauses an Enterprise schedule;
  `cleanup` releases the idle runtimes of the plugin's own.
- **Exports.** `download` leaves the provider and writes only inside the project or an allowed root.

## The bus

`changed` is emitted after every successful non-read method and every commit, with the capability area, the account and
the action as the short reason; an app re-reads the area. The kit's `events.emitted` stays `["changed"]`.

- **`colab.runs`** — `run`, `cancel`, and the `job.*` commits.
- **`colab.runtimes`** — `upload`, `cleanup`, and the `runtime.*` commits.
- **`colab.notebooks`** — `edit` and the `drive.*` commits.
- **`colab.schedules`** — `pause` and the `schedule.*` commits.
- **`colab.files`** — `download`: an export that changes only files in the project, so it nudges the file area rather
  than a provider source.

`colab.runs` and `colab.runtimes` are sources; the other three are app areas with no source of their own. `plan_write` and
`plan_delete` write nothing, so they emit nothing.
