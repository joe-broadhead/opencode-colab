# Accounts

Every account is an OpenCode integration: `colab` for `default`, `colab-<alias>` for any other alias. An alias matches
`^[a-z][a-z0-9]{0,31}$`. Every method that takes an account is declared `accounts: "optional"`; with more than one alias
and none named, the call is `ACCOUNT_REQUIRED` and the next step lists the aliases.

## Profiles

`options.accounts` is a map of alias to profile. Every field is optional, so `{}` is a valid profile.

<!-- generated:accounts -->
Accounts are held by the **integration** mechanism: the plugin holds the credentials.

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
2. Run `/connect`, choose the Colab integration for the alias, and paste a Google Desktop OAuth client ID and secret (or
   set `oauthClient` in the profile or the plugin options).
3. Choose Read-only or Read and write. The form lists every scope it requests before Google's own consent screen.

A `read` profile refuses every change on that account even if the sign-in holds a write scope. A `write` profile follows
the plugin's `access` level.

Headless accounts use `mode: "adc"` (Enterprise; application default credentials) or `mode: "token"` (a token in the
environment variable named by `tokenEnv`). They have no integration and no browser sign-in.

## Choosing an account in a call

```json
{ "account": "work", "notebook": { "path": "analysis.ipynb" } }
```

With one alias, omit `account`. With several, name it. `status` lists every alias with `ready`, `needs_sign_in` or
`error`; `probe` names the signed-in owner without reading content.
