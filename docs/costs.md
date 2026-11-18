# Costs, cleanup and status

What Colab costs, what the plugin does about it, and what it deliberately does not do. The design's sections are §8
(cost and cleanup), §14 (status and the TUI) and §16 F.

## What bills

**Consumer Colab** spends compute units (or the free tier's quota) while a runtime runs. Google publishes **no**
compute-unit balance or burn rate through any documented API: the Colab API exposes only the subscription tier
([Colab API reference](https://developers.google.com/colab/api/reference/rest), discovery `v1beta` revision 20261115),
and per-accelerator unit rates are not published and "vary over time"
([Colab FAQ](https://research.google.com/colaboratory/faq.html)). So the plugin counts **runtime-hours**, by
accelerator, and says `ratesKnown: false`. It never guesses a dollar figure for a consumer runtime.

Colab's own idle timeout and maximum lifetime are unpublished and not settable by a client; the FAQ says "at most 12
hours", Pro+ up to 24 h of continuous execution, and that idle timeouts apply only after code execution stops. Live
checks L7, L7b and L7c measure them on a real account.

**Colab Enterprise** bills the Cloud project: VM time, a management fee per vCPU-hour and GiB-hour, accelerator time
and disk GiB-hour, on demand ([Colab Enterprise pricing](https://cloud.google.com/colab/pricing), us-central1,
fetched 2026-11-17). Every estimate names the table's region and date; a machine or accelerator the table does not
price answers `ESTIMATE_UNKNOWN` rather than a guess. A **stopped** Enterprise runtime still bills its disk.

## Layer 1: bounds set at creation (they hold with the laptop off)

- A consumer run starts a **kernel-side watchdog** before its first cell and cancels it after the last: a silent
  `execute_request` in the agent's session, so a run is interrupted at `timeoutSec` even if OpenCode exits.
- An Enterprise job is created with `executionTimeout` = `jobTimeoutMinutes` (default 60 min, never above it).
- A schedule must have `maxRunCount` or `endTime`, and its shortest gap between occurrences must be at least
  `executionTimeout` + `provisioningMarginMinutes` (`SCHEDULE_OVERLAP`).

## Layer 2: the plugin's automation (while OpenCode runs, no agent needed)

Every 60 s, for **consumer runtimes the plugin created that are not tainted**:

1. **Idle comes from Jupyter.** Every kernel must report `execution_state: "idle"` and `last_activity` older than
   `autoReleaseMinutes` (default 20), no session but the plugin's own may be open (every name starts `oc-<nonce>-`), no
   kernel connection beyond the calibrated baseline plus one per session of ours, and no run of ours active. A runtime
   older than `maxRuntimeHours` (default 4) with the same conditions is released as `lifetime` — the backstop for a
   `last_activity` Jupyter never moved. Shapes: Jupyter Server's REST API,
   [rest-api.html](https://jupyter-server.readthedocs.io/en/stable/developers/rest-api.html).
   A runtime that is still `creating` is never swept and never closed: Colab may hold and bill it while the create's
   operation finishes. One older than 15 minutes is named in `attention` ("its create never finished; release it by
   plan"), as is any runtime with a run recorded running since a time ("colab_cancel or plan with force") and any
   runtime whose account is `access: "read"` — the automation changes nothing on such an account, and cannot ask.
2. **Harvest, then release.** The runtime's `keep` paths (default `/content/outputs/**`, fixed at creation) are
   downloaded into `<workDir>/harvest/<runtimeId>/content/outputs/…`, and only then is the runtime deleted. A harvest
   that fails — a read error, a tree deeper or larger than the harvest bounds, a file over `maxDownloadBytes` — blocks
   the release and is reported as `UNHARVESTED`. Nothing outside that folder is written. A **tainted** or still
   **creating** runtime can be released by a person's plan only: the transport fence refuses every read, so nothing is
   harvested, and the result says `UNHARVESTED`; a create Colab never had answers `gone` with nothing lost.
3. **Never** a runtime that is not the plugin's, a tainted one, one another OpenCode process holds (package B's owner
   lease, `<ledger>/owners/<runtime>.json`), or anything on Enterprise. There is no idle signal for an Enterprise
   runtime, and a stop loses its kernel memory.
4. **Consent.** Automation is a change, and it cannot ask: it follows the person's `access`. At `access: "all"` (the
   default) it is **on**; at `ask-changes` and `read-only` it is **off** (`off (access)`) unless the plugin option
   `automation` is `"on"` — the person's standing yes at any access level. `automation: "off"` turns it off at `all`.
   `colab_status`, `/colab-status` and the TUI report `on`, `on (consent)`, `off`, `off (access)` or `not-owner`, and
   list what it left alone in `attention`. A deny rule on `colab.delete` does **not** stop the automation — it is not
   a tool call and cannot ask; `automation: "off"` is the switch.

**A release loses everything outside `keep` and every variable in memory.** That sentence is in the `runtime.create`
plan's preview, in `jelly.cost`, in the `runtime.delete` preview and in every cleanup entry below. A tainted runtime —
one where the plugin has observed a credential or another client — is released only by an explicit plan, with
`UNHARVESTED` in its warnings, because the transport fence refuses every read on it.

## Layer 3: what agents see

`colab_status` answers:

- `cost`: consumer runtime-hours today and running, by accelerator, `ratesKnown: false`; Enterprise $/h for every
  running runtime with the end-user-credential and idle-shutdown flags; today's job estimate from the ledger and
  whether it is complete (a run whose record does not name its compute is counted as unpriced, never guessed);
- `cleanup`: the biggest saving first, each entry **one call** — the `runtime.delete` plan for an idle runtime of ours,
  and a `runtime.stop` plan for an Enterprise runtime whose entry carries §7.2's warning word for word ("kernel state
  and running cells are lost; the disk is kept and still billed; the person may be using this runtime — there is no
  idle signal"). Nothing stops an Enterprise runtime by itself;
- `automation`, and `lastErrors` — the plugin's own codes, no Google text.

Hooks (design §8.4): one line of at most 200 characters on the **tail** of `messages` when a runtime of ours is running
and the coarse figures changed (never in `system`, so the cached prefix is untouched); a compaction part asking the
summary to keep the open runtime ids; and an `experimental.idle` note only when money is burning, automation will not
handle it, at most once per 30 minutes per session and never in the execution its own note started. A hook never fails
a request.

## Layer 4: the person

`/colab-cleanup` lists **every live runtime of ours** — ready, still creating, tainted, or one that has run code — with
its spec, today's runtime-hours, how long since a run, and that a release loses files outside `keep` and memory. A
runtime with a run recorded running is listed but not offered (the release would refuse it): the report says
`colab_cancel` first. Then it offers each release with **one permission prompt per runtime**, answered by a person:

- `access: "all"`: the prompt asserts the command's own action `colab.cleanup`;
- `access: "ask-changes"`: it asserts `colab.delete`, the tool action the default rules already ask for, so a person is
  never asked twice;
- `access: "read-only"`: **a report only**. It lists, asserts nothing and releases nothing.

The prompt carries no tool `source`, so it is not a tool call the model could replay. A yes runs that one release in the
plugin's process through the same release function the automation uses; a no changes nothing and moves on to the next.
Enterprise runtimes are not stopped here: `colab_runtimes` lists them with $/h, and stopping one is a `runtime.stop`
plan, which says what a stop loses.

The TUI's status dialog and `/colab-status` show a **Cost**, an **Automation** and, when something was left alone, an
**Attention** row from the local ledger and the options; the full block, with Jupyter's idle figures and Enterprise $/h,
is `colab_status`. The dialog has no buttons yet: run `/colab-cleanup`, whose prompts are the confirmation (a v1-design
checklist note).

## Budgets (opt-in)

Per account in `accounts.<alias>.budget`:

```jsonc
{ "enterpriseUsdDaily": 20, "runtimeHoursDaily": 8, "action": "warn" }
```

| Action | Limit it is measured against |
| --- | --- |
| `runtime.create` | `runtimeHoursDaily` (consumer runtime-hours today, plus the runtime's lease) |
| `job.create`, `schedule.create`, `schedule.resume` | `enterpriseUsdDaily` (today's Enterprise estimate, plus the call's own estimate) |

`refuse` answers `BUDGET_REACHED` at the preview and the commit; `warn` adds the `BUDGET_WARN` warning and runs.
Releasing, pausing, stopping and cancelling never ask, because they lower the cost.

How each figure is measured, said plainly:

- consumer runtime-hours come from the ledger (each record's creation to its release, inside the person's local day),
  so that limit is complete;
- today's Enterprise USD is the sum of the day's runs' `estimatedUsd` — the estimate package E stores at each job's
  commit, the same figure its preview showed and its commit re-checked — or, for a record whose `spec` names its
  machine, E's dated table. The verdict is then exactly: counted spend plus the call's own estimate within the limit →
  `ok`; over it → `refuse`, or `warn` when the budget's action is warn. So two $5 jobs against a $10 daily `refuse`
  limit make the third $5 job `BUDGET_REACHED`.
  A **legacy** run with no estimate and no `spec` (one created before this change, or by another client) is uncounted:
  it contributes `$0`, so a call within the rest of the limit answers `ok` even though the real spend is higher, and
  `colab_status` reports `jobsToday.complete: false`. That is the one case where the daily figure is a floor.

## Live checks

Not run before release, and named as such in the design: **L7** (Colab's idle release of an API-created runtime),
**L7b** (compute-unit burn of an idle API runtime) and **L7c** (whether Colab reclaims a runtime whose code is running
when the only client is an API WebSocket). The unit and host suites prove the plugin's side: the idle rule, the harvest,
the consent matrix, the owner lock, the hooks and the command. They cannot measure Google's billing, and this page does
not claim they do.
