# Scripting

Unofficial plugin. Not affiliated with Google.

A script can call the plugin's read tools with no model: a cron job, a shell script, or any program that can reach the
OpenCode server. It uses the tools RPC, `google-colab.tools`, through `opencode api` or an OpenCode client:

```sh
opencode api post /api/rpc/google-colab.tools/<method> -H "x-opencode-directory:$PWD" -d '{"input":{"sessionID":"<id>","input":{…}}}'
```

The transport is the source contract's (`@we-the-rebel-alliance/source-contract`, tag v0.2.0), shared by the family.

| Method | Class | What it does |
| --- | --- | --- |
| `describe` | none | Lists every method with its class, its permission action and whether it can run now. |
| `status`, `specs`, `runtimes`, `find`, `notebook`, `files`, `execution`, `jobs`, `schedules`, `plan`, `events_list`, `runtimes_read` | read | The read tool of the same name, with the same input and result. |
| `probe` | read | The source contract's probe: names the signed-in account, reads no content. |

Changes — running code, uploads, downloads, edits, pauses and commits — are never methods: each is a step a person
sees.

## A script runs as a session

Every call names a session, and the session must name an agent. Create it for the script once, with the project as its
`location`, and keep its id:

```sh
opencode api post /api/session -d '{"title":"colab digest","agent":"build","location":{"directory":"/path/to/project"}}'
```

Only a prior explicit `allow` for a method's action runs: an `ask` is refused, because nobody can answer it.

## Errors

A refusal from the transport is the RPC error `failed`, with a message `CODE: what happened. Next step: what to do.`
and `data: { code, next }`.

| Code | When |
| --- | --- |
| `PERMISSION_DENIED` | The rules ask or deny. An `ask` is refused before dispatch. |
| `SESSION_UNKNOWN` | OpenCode says the session does not exist in this location. |
| `SESSION_AGENT_REQUIRED` | The session names no agent, or an agent that does not exist. |
| `CANCELLED` | The request was cancelled. |

A read method's own refusal or failure is its result, `{ state, error, message, next }`, with a code from
[Errors](errors.md). The source methods are the exception: `events_list`, `runtimes_read` and `probe` refuse with the
source contract's codes (below), as a consumer expects.

## Sources

The plugin declares two sources in `package.json` `sources`, for the
[source contract](https://github.com/we-the-rebel-alliance/source-contract) v0.2.0. A consumer (Memory, Jelly, your own
script) reads them through the methods above, keeps the cursor, and asks for nothing else.

| Source | Method | Asserts | What it answers |
| --- | --- | --- | --- |
| `colab.runs` | `events_list` | `colab.events_list`, then `colab.read` on `<account>:colab.ledger.list` | A page of events, oldest first by end time: one per finished run or Enterprise job this plugin started. |
| `colab.runtimes` | `runtimes_read` | `colab.runtimes_read`, then `colab.read` on `<account>:colaboratory.runtimes.list` (a Colab account) or `<account>:aiplatform.projects.locations.notebookRuntimes.list` (an Enterprise account) | A `list` snapshot of the account's runtimes, at most 50. |
| both | `probe` | `colab.probe` | Whose the source is (`owner`) and the sign-in's scopes. No content, no Google call. |

```sh
opencode api post /api/rpc/google-colab.tools/events_list -H "x-opencode-directory:$PWD" \
  -d '{"input":{"sessionID":"<id>","input":{"source":"runs","account":"default","since":"2026-11-17T00:00:00Z","limit":100}}}'
```

### `colab.runs`

- **What an event holds.** `external_id` is the run id (an Enterprise job's id), `occurred_at` its end, `kind`
  `x-colab/run`, `thread` the runtime it ran on, `labels` `backend:`, `state:`, `code:`, `accelerator:` and `runtime:`,
  and `title` the plugin's sentence: "Ran 6 cells of analysis.ipynb on T4 GPU — failed (KERNEL_DIED), 42 s", or
  "Colab Enterprise job nightly-3 of report.ipynb succeeded, 12 min". No `text`, no `url`, no `actors`; never cell
  text, an output or a traceback.
- **Whose it is.** The owner is this computer's OS user, `os-user:<user>@<computer>`, as the family's other ledger
  source (boxd's) names it: the ledger records runs by account alias, not by Google identity, so the read needs no
  sign-in. `colab.runtimes` is owned by the signed-in Google account (`mailto:<email>`), or by the plugin's own
  `colab:account:<alias>` where Google names no verified email; never `verified: false`, which today's consumers refuse.
- **When a run is listed.** When its end is recorded in the plugin's ledger, which assigns it the next position in the
  ledger's log. A run that lasts hours, or a job whose end the plugin observes hours after Google recorded it, is
  listed then, behind nothing: there are no late arrivals. Each run is listed once.
- **The cursor** is the position of the last entry the read covered, bound to the plugin, the source and the account.
  A page covers every entry it passes, so the cursor moves on every page, whatever the burst. Another account's or
  source's cursor is `CURSOR_INVALID`.
- **A first read** without a cursor starts at `since`, or 24 hours back, and lists runs that ended at or after it.
- **Retention.** The ledger keeps `ledgerDays` (90). A cursor whose next entries were pruned answers one page with
  `gap: { reason: "expired", since }`, `since` being where the cursor's history ended, then restarts at the oldest kept
  entry; the next pages carry no gap. A deleted ledger answers the same one gap.
- **A run whose writer recorded its end without a log entry** is given one by the read itself, in the plugin's ledger,
  before it pages: the run is listed on that read.

### `colab.runtimes`

Each item is `{ id, text, note }` (`output.list`): the plugin's own runtimes first, with their spec, whether they are
tainted, their age and when they are released; a runtime opened elsewhere is marked "not the plugin's own"; an
Enterprise runtime names its machine, accelerator, state, USD per hour when the dated price table has it, and its
idle-shutdown and end-user-credential flags. More than 50 runtimes, or a listing Google's paging cut, is `TOO_LARGE`.

### Refusals

| Code | When |
| --- | --- |
| `NEEDS_SIGN_IN` | `runtimes_read`, or `probe` for `runtimes`: the account is not signed in, or its credential is no longer accepted. |
| `SCOPE_MISSING` | The sign-in lacks the scope the listing needs. |
| `ACCOUNT_MISMATCH` | `probe` named an account the plugin does not have. |
| `CURSOR_INVALID` | The cursor is not one this source issued for this account. |
| `SOURCE_UNKNOWN` | The input named a source other than `runs` or `runtimes` (or their ids, `colab.runs` and `colab.runtimes`). |
| `INPUT_INVALID` | The input does not fit the method, such as a `scope` (neither source reads one). |
| `TOO_LARGE` | `runtimes_read` past 50 runtimes. |
| `RATE_LIMITED`, `UNAVAILABLE`, `PERMISSION_DENIED` | Google's answer to the listing; `UNAVAILABLE` names the plugin's own code when it has one. |

> **Pre-release.** Until the next change to the plugin's contract lands: `probe` over the tools RPC answers
> `UNAVAILABLE`; a source refusal reaches a script as an error carrying the `CODE: …` message rather than as `failed`
> with `data.code`; and the tool wrapper's own refusals (an account the plugin does not have, an input its schema
> refuses) come back as a result `{ state, error, message, next }` instead of `ACCOUNT_MISMATCH` or `INPUT_INVALID`.
> The package's tests call the source functions directly.

## Status

The status RPC, `google-colab`, returns what `/colab-status` shows, and makes no call to Google:

```sh
opencode api post /api/rpc/google-colab/status -H "x-opencode-directory:$PWD" -d '{"input":{}}'
```

The family's shared fields are `version`, `host`, `unguardedAgents` and `nextStep`. Colab's own fields beside them:
`access`, `accounts`, `tools`, `permissionsBlock`, `shadowedSkills`, `problems` and `hostWarning`.
