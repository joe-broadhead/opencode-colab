# Sign-in and accounts

Unofficial plugin. Not affiliated with Google.

Colab tools run as a Google account. This page covers how an account signs in, which scopes each backend and level
requests, the headless modes for Colab Enterprise, and what `/colab-doctor` checks. Every Google shape below comes from
Google's own documentation, cited inline; the live checks that would confirm the unproven ones (L1, L3, L4, L14) have
not run, and this page says which facts depend on them.

## Accounts

`accounts` maps an alias to its settings. With no `accounts` option there is one account, `default`, backend `colab`,
interactive, at read and write. A named account defaults to read-only (design §4).

| Setting | Values | Default |
| --- | --- | --- |
| `backend` | `colab` (your own Colab and compute units) or `enterprise` (a Google Cloud project) | `colab` |
| `mode` | `interactive`, `adc`, `token` | `interactive` |
| `access` | `read` or `write` | `write` for `default`, `read` otherwise |
| `drive` | whether Drive notebooks are in scope, which adds `drive.file` | `true` for `colab`, `false` for `enterprise` |
| `project`, `region` | the Enterprise project and location | none; both are required for an Enterprise account |
| `outputBucket` | `gs://…` where Enterprise runs write their output notebook | none |
| `serviceAccount`, `runAsUser` | the Enterprise run identity | neither; a job needs one |
| `oauthClient`, `scopes`, `tokenEnv`, `impersonate` | as below | none |

One backend per account: a person with both makes two accounts, for example `personal` (`colab`) and `work`
(`enterprise`).

## The scopes each sign-in requests

The form shows these exact scope URLs before Google's consent screen, and the sign-in requests nothing else.

| Account | Read | Read and write |
| --- | --- | --- |
| `colab` | `openid`, `userinfo.email`, `colaboratory.readonly` (+ `drive.file`) | `openid`, `userinfo.email`, `colaboratory` (+ `drive.file`) |
| `enterprise` | `openid`, `userinfo.email`, `cloud-platform` | the same |

- `openid` and `userinfo.email` (https://www.googleapis.com/auth/userinfo.email) give the ID token and the account's
  email; the Colab API needs `colaboratory` or `colaboratory.readonly`
  (https://developers.google.com/colab/api/reference/rest), and Drive uses `drive.file`
  (https://developers.google.com/workspace/drive/api/guides/api-specific-auth), which reaches only files this client
  created or was given.
- Enterprise checks `cloud-platform` because every Vertex notebook method accepts only that scope (Vertex AI discovery
  v1, revision 20261107: `notebookExecutionJobs`, `notebookRuntimeTemplates`, `notebookRuntimes`).
- `colaboratory.readonly` is **not** a code-execution fence: `runtimes.get` accepts it and returns the runtime's proxy
  token, and that token runs code (Colab discovery v1beta, revision 20261115). The plugin's own access rules are the
  fence, and live check L4 only confirms the proxy does not re-check the scope.
- Enterprise has no read-only scope. A read Enterprise account therefore holds `cloud-platform`, which reaches more
  than the plugin's access; status and the doctor say `SCOPE_WIDER_THAN_ACCESS`. If live check L3 shows the notebook
  methods accept `aiplatform` + `devstorage.read_only`, a later version narrows that set.
- **`access` is the fence.** A read account's form offers read-only; write is offered only to an account configured
  `access: "write"`.
- Extra scopes on `accounts.<alias>.scopes` are always requested and always shown.

## Interactive sign-in

Run `/connect` and choose **Colab**, or **Colab (`alias`)** when several accounts can sign in, and press `o` or Enter to
open Google's sign-in link in the browser. `opencode auth login colab-<alias>` does the same from the CLI. Headless
accounts (`adc`, `token`) have no sign-in and no `/connect` entry.

The plugin uses Google's OAuth 2.0 flow for desktop applications (https://developers.google.com/identity/protocols/oauth2/native-app):

- **PKCE (S256)** and a random `state` per sign-in; the challenge is `BASE64URL(SHA256(verifier))`.
- A **loopback redirect** on `127.0.0.1` at a free port, with `access_type=offline` and `prompt=consent` so Google
  returns a refresh token.
- The code exchange and refresh post to `https://oauth2.googleapis.com/token` with the client and the
  `code_verifier`/`refresh_token`.

No credential file is written. Tokens, the client, the level and the granted scopes live in OpenCode's credential
store, attached to the integration. The plugin writes no token, secret or client anywhere else.

### The form

| Field | When it shows | What it does |
| --- | --- | --- |
| OAuth client ID, OAuth client secret | When no client is configured | The ID and secret of your Desktop app client. Left blank, the sign-in reuses the client entered at this account's previous sign-in. With a configured client both fields are hidden and left blank, so no secret enters the form. |
| Access | Always | **Read-only** or **Read and write**; each option lists the exact scope URLs it requests. A read account sees Read-only only. |
| I understand this grants write access to: … | When Read and write adds scopes | The acknowledgment. Without it the sign-in stops with `INPUT_INVALID` before any network call. |
| OAuth client JSON | Never: a host fills it | Google's downloaded client JSON (`{"installed": …}` or `{"web": …}`), which replaces the client ID and secret. Jelly provides its Google client this way (`jelly.signIns[0].hostClient`). |
| OAuth redirect URI, OAuth callback port | Never: a host fills them | The relay below. The plugin options `redirectUri` and `callbackPort` are their defaults. |

### OAuth client

No OAuth client ships with the plugin. Use your own Desktop app client, or one an organisation sets through
`oauthClient`: Google's downloaded client JSON, or `"<clientId>:<clientSecret>"`. Create it under Google Cloud console →
Google Auth platform → Clients → **Desktop app**. Google treats an installed app's secret as non-confidential; security
rests on PKCE, the loopback redirect and your consent, not on the secret.

Client precedence, first match wins:

1. `accounts.<alias>.oauthClient`
2. the plugin `oauthClient`
3. the client entered in the form
4. the client entered at this account's previous sign-in

With none, the sign-in stops with `AUTH_CLIENT_REQUIRED` before any request. Do not paste a client secret into a chat,
a skill or a commit message; prefer the form or the host's client to a config file an agent can read.

### Signing in from a browser on another machine

By default Google returns the browser to `http://127.0.0.1:<port>`, which works only when the browser runs on the same
computer as OpenCode. When OpenCode runs elsewhere, the host that serves it supplies the redirect:

- `redirectUri`: the public URL Google returns to, for example `https://host.example/oauth/return`.
- `callbackPort`: the local port the host forwards that URL to, unchanged, on `127.0.0.1`.

Set them as plugin options, or let the host fill the form's hidden fields of the same names; a filled field wins over
its option. Google accepts only loopback redirects for a Desktop app client, so a public redirect needs a **Web
application** client whose registered redirect URIs include `redirectUri` exactly. Before anything listens, the plugin
refuses a Desktop client with a public redirect and a Web client whose list does not contain it.

Google matches a public redirect character for character; a deployment with many hosts registers each one, or uses one
relay address that forwards to the right host.

## Session control

A Workspace administrator can limit how long a Google Cloud session lasts
(https://support.google.com/a/answer/9368756). A `cloud-platform` refresh then fails with `invalid_grant` and a
reauthentication subtype; the recorded shape is `"error_subtype":"invalid_rapt"` with
`"error_description":"reauth related error (invalid_rapt)"`. The plugin answers `AUTH_REQUIRED` with
`reason: "session-control"`, tells the person to sign in again, and names the administrator's fix: add the client to
trusted apps and exempt it. `colaboratory` is not a Cloud scope, so a consumer account should not be affected; live
check L1 verifies that, and L3 confirms the Enterprise error's shape.

## Headless Enterprise accounts

Both modes are opt-in and never a fallback. They are for an `enterprise` account only.

### `mode: "adc"`

Application Default Credentials, looked up where Google's libraries look, in Google's order
(https://cloud.google.com/docs/authentication/application-default-credentials):

1. the file `GOOGLE_APPLICATION_CREDENTIALS` names (a service account key, or a `gcloud auth application-default
   login` user credential);
2. the gcloud file, `$CLOUDSDK_CONFIG/application_default_credentials.json` or
   `~/.config/gcloud/application_default_credentials.json` (`%APPDATA%\gcloud\…` on Windows);
3. the metadata server, on a Google Cloud resource with an attached service account.

A service account key signs the JWT bearer grant (RS256; `iss`, `scope`, `aud`, `exp`, `iat`;
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`) from
https://developers.google.com/identity/protocols/oauth2/service-account. A user credential refreshes like any other
refresh token. With `impersonate: "service-account@project.iam.gserviceaccount.com"`, the credential is exchanged for
that service account's token through `serviceAccounts.generateAccessToken`
(https://cloud.google.com/iam/docs/create-short-lived-credentials-direct); the caller needs
`roles/iam.serviceAccountTokenCreator` on it.

ADC is refused under a managed host — Jelly's engine sets `OPENCODE_DISABLE_PROJECT_CONFIG=1` or
`OPENCODE_CONFIG_PROJECT_DISABLE=1` — unless the operator sets `allowAdcInHost: true`. Workforce and Workload Identity
Federation (`external_account`) credential files are not read in v0.1.0; live check L3 would add them.

### `mode: "token"`

The access token is the value of the environment variable named by `tokenEnv`. Nothing refreshes it, and nothing proves
whose token it is, so `identity()` is undefined for such an account. Set `tokenEnv` and keep the value out of config
files.

## Reading scopes, identity and status

Before any Google request, the plugin compares the scopes a call needs with the grant the stored sign-in holds. A miss
answers `AUTH_SCOPE_MISSING` and no request leaves the machine. The check understands the few implications that matter:
`colaboratory` covers `colaboratory.readonly`, and `cloud-platform` covers the narrow Enterprise set.

The account's email comes from the ID token's `email` and `email_verified` claims
(https://developers.google.com/identity/openid-connect/openid-connect). The token arrives directly from Google's token
endpoint over HTTPS, so its signature is not re-verified; its `iss`, `aud` and `exp` claims are still checked against
the client and the clock.

`/colab-status` shows each account's backend, sign-in, scopes and project. `/colab-doctor` is described below.

## `/colab-doctor`

`/colab-doctor` makes one small read per account and reports one line per check:

| Account | Check | What it proves |
| --- | --- | --- |
| `colab` | `runtimespecs.list` (`GET v1beta/runtimespecs`) | the sign-in, the scope and the Colab API |
| `enterprise` | `notebookRuntimeTemplates.list` | the project, the scope and the Vertex AI API |
| `enterprise` | one bucket listing (`storage/v1/b/<bucket>/o`) | read access to `outputBucket` |
| both | `runtime print(1)` (except at read-only) | that a two-second `print(1)` runs on a runtime of the plugin's own |

Each provider read asserts `colab.read` on `<account>:<operation>`; the print asserts `colab.run` on the operation and
the runtime, exactly as a run does. Statuses are design §14's: `OK`, `AUTH_REQUIRED`, `AUTH_SCOPE_MISSING`,
`COLAB_API_UNAVAILABLE`, `API_DISABLED` (with the console link that enables the API), `PERMISSION_DENIED`, plus
`SKIPPED`, `DENIED` and the plugin's own account codes (`PROJECT_REQUIRED`, `ADC_REFUSED`, …).

The runtime print is skipped at `read-only`, when no runtime of the plugin's own is running, and — in this version —
when the plugin's runtime ports are not wired into the sign-in registration, because the host registration does not
receive the plugin's runtime ports in this version. The line says which.

Google's answer text is never copied into a status line: the report is built from the HTTP status and Google's reason
markers only, because a status line reaches the model and Google's words are untrusted.

## What is not proven yet

- **L1**: whether a third-party Desktop client can be granted `colaboratory`, and what enabling
  `colaboratory.googleapis.com` requires. If it cannot, notebook editing still works and runs need an `enterprise`
  account.
- **L3**: whether the Vertex notebook methods accept `aiplatform` + `devstorage.read_only` instead of `cloud-platform`,
  and session control's exact `invalid_grant` shape.
- **L4**: whether the runtime proxy accepts a `colaboratory.readonly` token (already assumed: the scope is not a fence).
- **L14**: the sign-in through a relay with the host's `google` client, and the verification class of `colaboratory`.
