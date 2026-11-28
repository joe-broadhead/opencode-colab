# Accounts

Every account is an Agent Platform MCP server: `colab` for `default`, `colab-<alias>` for any other alias, with the
plugin's Google sign-in on the integration OpenCode gives the server. An alias matches `^[a-z][a-z0-9]{0,31}$`. Every
method that takes an account is declared `accounts: "optional"`; with more than one alias and none named, the call is
`ACCOUNT_REQUIRED` and the next step lists the aliases.

## Profiles

`options.accounts` is a map of alias to profile. Every field is optional, so `{}` is a valid profile.

<!-- generated:accounts -->
Accounts are held by the **mcp** mechanism: the vendor's MCP server holds them.

| Field | Type | Required |
|---|---|---|
| `backend` | `colab` \| `enterprise` | no |
| `mode` | `interactive` \| `adc` \| `token` | no |
| `access` | `read` \| `write` | no |
| `drive` | boolean | no |
| `project` | string | no |
| `region` | string | no |
| `outputBucket` | string | no |
| `serviceAccount` | string | no |
| `runAsUser` | boolean | no |
| `oauthClient` | string | no |
| `scopes` | array | no |
| `tokenEnv` | string | no |
| `impersonate` | string | no |
| `budget` | object | no |
<!-- /generated:accounts -->

## Sign in

1. Add the aliases to `options.accounts`.
2. Run `/connect`, choose the Colab server's integration for the alias, and paste a Google Desktop OAuth client ID and
   secret (or set `oauthClient` in the profile or the plugin options).
3. Choose Read-only or Read and write. The form lists every scope it requests before Google's own consent screen.

A `read` profile refuses every change on that account even if the sign-in holds a write scope. A `write` profile follows
the plugin's `access` level.

Headless accounts use `mode: "adc"` (Enterprise; application default credentials) or `mode: "token"` (a token in the
environment variable named by `tokenEnv`). They have no MCP sign-in and no method, so they keep the plugin's own
reads, including the Enterprise reads an interactive account passes through to the server.

## The Enterprise reads

Google Cloud's Agent Platform MCP server (`https://aiplatform.googleapis.com/mcp/notebook`) serves an interactive
account's Enterprise jobs, schedules, runtime templates and runtimes. Its tools are the manifest's `mcp:` rows:
`mcp:notebook_execution_list_jobs`, `mcp:notebook_execution_get_job`, `mcp:list_notebook_execution_schedules`,
`mcp:get_notebook_execution_schedule`, `mcp:colab_enterprise_list_notebook_runtime_templates`,
`mcp:colab_enterprise_list_notebook_runtimes`, `mcp:colab_enterprise_get_notebook_runtime` and `mcp:get_operation`. The
plugin's own copies of those reads refuse with `UNAVAILABLE` and name the tool. The plugin's plans, cost view and
source keep their reads because the server offers no preview, cost or cursor, and its create, update and delete methods
stay the plugin's plan-then-commit.

## Choosing an account in a call

```json
{ "account": "work", "notebook": { "path": "analysis.ipynb" } }
```

With one alias, omit `account`. With several, name it. `status` lists every alias with `ready`, `needs_sign_in` or
`error`; `probe` names the signed-in owner without reading content.
