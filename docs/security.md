# Security

## What leaves the machine

Only the calls the person's method makes: Colab and Vertex API requests, Drive and Cloud Storage requests, and the
runtime's own Jupyter HTTP and WebSocket connections. Sign-in and refresh go to Google's OAuth endpoints. Nothing is
sent to the plugin's authors or to any other app.

## Scopes

- A consumer account requests `colaboratory` for write profiles and `colaboratory.readonly` for read profiles. The
  Colab API also needs the user's own OAuth client; set `oauthClient` per account or plugin.
- An Enterprise account requests `cloud-platform` and a Drive/GCS scope. Enterprise has no narrower read-only scope; a
  `read` profile refuses changes in the plugin even when the token could write.
- The exact scope list is shown in the sign-in form before Google's consent screen.

## Redaction

No token, refresh token, client secret, runtime URL or notebook text enters an error, status, a log or a bus event.
Status reasons are redacted and cut to 160 characters. An event whose text is secret-shaped is refused with reason
`secret`; instruction-shaped text from someone else may be refused too.

## Permission

The contract's `register` asserts `<name>.<method>` on `<alias>:<operation>` once per call, for every door. The `access`
setting is final: `read-only` refuses every non-read, `ask-changes` asks for every non-read, `all` runs them. Non-local
commits over RPC need an answered ask or a host-signed action grant.

## Plan and commit

A change with a cost or a destructive effect is previewed by `plan_write` or `plan_delete`, which writes nothing and
names the exact target and effects. The person sees the preview; `write` or `delete` commits only `{ planId }`, reads
the plan the register kept, and re-checks the target. A plan expires after 15 minutes and commits once.

## Files

Local reads and writes resolve inside the project or an allowed root; a symlink that escapes is refused. Writes are a
temporary file plus a rename. A download never overwrites an existing path unless the call says so.

## Local files and the host's edit permission

A local notebook write is gated by the contract's `colab.edit` action (or `colab.upload`/`colab.download` for the
transfer methods) and by the plugin's path rules: the target must resolve inside the project or an allowed root, a
symbolic link that escapes is refused, and an existing file needs its current hash or `overwrite`. The plugin does not
assert OpenCode's generic `edit` permission separately; the contract's register is the one permission door.
