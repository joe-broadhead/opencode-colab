// The plugin's fixed facts: its ids, its namespace, the host range and the tested releases. No imports at all:
// scripts/check.mjs loads this file with Node's type stripping, so it may hold only erasable TypeScript.

/** The plugin's id. The tools RPC is `<PLUGIN_ID>.tools`, which package.json `sources.rpc` names. */
export const PLUGIN_ID = "google-colab"
/** The tools' namespace: tool ids are `colab_<tool>`, permission actions `colab.<tool>`. */
export const NAMESPACE = "colab"
/** The name status, `/connect` and the dialog show. */
export const DISPLAY_NAME = "Colab"
/** The status command, `/colab-status`. */
export const STATUS_COMMAND = `${NAMESPACE}-status`
/** The integration id prefix: one integration per account alias, `colab-<alias>`. */
export const INTEGRATION_PREFIX = `${NAMESPACE}-`

/** What the generated default rules allow. `all` is the default; the other two restrict the plugin. */
export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]

/** The OpenCode versions the plugin starts on. Equals `opencode.host` in package.json. */
export const SUPPORTED_HOST = ">=2.4.1 <2.5.0"
/** The OpenCode releases every check runs on: the one list. Status calls only these "tested". */
export const TESTED_HOSTS: readonly string[] = ["2.4.1"]
