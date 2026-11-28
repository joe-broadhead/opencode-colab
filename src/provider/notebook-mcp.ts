/**
 * Google Cloud's Agent Platform MCP server, notebook toolset, as OpenCode's MCP client takes it.
 *
 * The server is one per account alias, named by the contract's rule (`colab` for `default`, `colab-<alias>`
 * otherwise). `oauth: {}` asks the host to give it an integration and a sign-in method; `src/accounts.ts` replaces
 * that generic method with the plugin's Google sign-in, so an interactive account signs in once and the plugin's own
 * reads use the same grant.
 *
 * The server's Enterprise reads are the plugin's pass-through tools (`mcp:` rows in the manifest); its writes stay
 * the plugin's own plan-then-commit methods. This module is the only place the server URL is written.
 */

/** Google Cloud's Agent Platform MCP server, notebook toolset: the streamable HTTP endpoint. */
export const NOTEBOOK_MCP_URL = "https://aiplatform.googleapis.com/mcp/notebook"

/** The remote server config for one account's server name. */
export function notebookMcpServer(): Record<string, unknown> {
  return { type: "remote", url: NOTEBOOK_MCP_URL, oauth: {} }
}
