// The plugin's fixed facts: its one name and the host range. Every id derives from `colab`.
export const PLUGIN_NAME = "colab"
export const DISPLAY_NAME = "Colab"
/** The status command (§3): `/<name>`. */
export const STATUS_COMMAND = PLUGIN_NAME
/** The OpenCode range and tested releases; package.json's capabilities.plugin.host is the authority. */
export const SUPPORTED_HOST = ">=2.4.1 <2.5.0"
export const TESTED_HOSTS: readonly string[] = ["2.4.1"]
export const ACCESS_VALUES = ["all", "ask-changes", "read-only"] as const
export type Access = (typeof ACCESS_VALUES)[number]
