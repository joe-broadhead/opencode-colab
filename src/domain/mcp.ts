/**
 * The Enterprise reads Google's Agent Platform MCP server serves (plugin-contract §6, decision D12).
 *
 * An interactive Enterprise account signs in to the server, and the server's `mcp:` tools are the read surface for
 * its jobs, schedules, runtime templates and runtimes. The plugin's own copy of those reads refuses and names the
 * tool, so there is one answer and one place to chase Google's changes. A headless account (adc, token) has no MCP
 * sign-in, so it keeps the plugin's own read, and the plugin's plans, cost view, source and GCS capture keep theirs
 * because the server does not offer them.
 */
import type { ResolvedAccount } from "../options.js"
import { ColabError } from "./errors.js"

/** The pass-through tools, as the manifest declares them. */
export const MCP_READS = {
  jobs: "mcp:notebook_execution_list_jobs",
  job: "mcp:notebook_execution_get_job",
  schedules: "mcp:list_notebook_execution_schedules",
  schedule: "mcp:get_notebook_execution_schedule",
  templates: "mcp:colab_enterprise_list_notebook_runtime_templates",
  runtimes: "mcp:colab_enterprise_list_notebook_runtimes",
  runtime: "mcp:colab_enterprise_get_notebook_runtime",
} as const

/** The read a method's own copy would perform, and the tool that replaces it. */
export function refuseMcpRead(method: string, input: { readonly schedule?: string; readonly runtime?: string; readonly job?: string }, account: ResolvedAccount): void {
  if (account.mode !== "interactive" || account.backend !== "enterprise") return
  switch (method) {
    case "jobs":
      refuse(MCP_READS.jobs, "Listing Enterprise jobs")
      return
    case "schedules":
      if (input.schedule === undefined) refuse(MCP_READS.schedules, "Listing Enterprise schedules")
      else refuse(MCP_READS.schedule, "Reading one Enterprise schedule")
      return
    case "specs":
      refuse(MCP_READS.templates, "Listing Enterprise runtime templates")
      return
    case "runtimes":
      if (input.runtime === undefined) refuse(MCP_READS.runtimes, "Listing Enterprise runtimes")
      else refuse(MCP_READS.runtime, "Reading one Enterprise runtime")
      return
    case "execution":
      if (input.job !== undefined) refuse(MCP_READS.job, "Reading one Enterprise job")
      return
    default:
      return
  }
}

function refuse(tool: string, what: string): never {
  throw new ColabError("MCP_HANDOFF", `${what} is served by Google's Agent Platform MCP server, and the plugin's own read does not run it.`, {
    next: `Call ${tool}; it returns the same data. A headless account (adc or token) keeps the plugin's own read.`,
  })
}
