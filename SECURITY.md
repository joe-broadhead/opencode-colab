# Security

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

Report a vulnerability privately through GitHub's security advisories for this repository, not in a public issue.

## Data handling

### Network access

The plugin's requests go only to Google: the Colab API (`colaboratory.googleapis.com`), a runtime's Jupyter server
through the `connectionInfo.url` the Colab API returns (https on an allowed Google host only), Vertex AI
(`aiplatform.googleapis.com`), Drive and Cloud Storage. Status makes no request.

### Credentials

- Google sign-ins are stored by OpenCode, per account alias (`colab-<alias>`). The plugin reads them when a call needs
  them and asks Google only for the scopes the call needs.
- A runtime's proxy token and URL are credentials: never logged, returned, or put in an error or a status line.
- The plugin never puts a credential on a runtime, and declines every credential request a runtime makes
  (`colab_request`, stdin).
- Uploads refuse secret-shaped files unless `allowSecretUpload` is set; inline outputs and previews replace
  secret-shaped text with `[withheld: secret-shaped]`.

### Untrusted content

Notebook text, outputs, images and Drive names are data, never instructions. The namespace description and the skills
say so to the model; the plugin keeps that text out of every `message` and `next`.

## Permissions

The default rules allow reads and give changes the effect the `access` option sets. Agents without the block are named
in `/colab-status`.

## Scripts

Scripts call the read tools through the tools RPC as a session and its agent; only a prior explicit `allow` runs, and
an `ask` is refused. Changes are never RPC methods.
