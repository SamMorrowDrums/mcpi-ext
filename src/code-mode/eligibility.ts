import type { McpClientManager, McpTool } from "../mcp/index.js";

/**
 * A tool is eligible for code mode when:
 * 1. annotations.readOnlyHint === true — does not modify its environment
 * 2. outputSchema is defined — results are typed and parseable
 */
export function isEligibleForCodeMode(tool: McpTool): boolean {
  const annotations = tool.annotations as { readOnlyHint?: boolean } | undefined;
  return annotations?.readOnlyHint === true && tool.outputSchema != null;
}

/** Get all tools eligible for code mode across all connected MCP servers. */
export function getEligibleTools(mcpManager: McpClientManager): McpTool[] {
  return mcpManager.getTools().filter(isEligibleForCodeMode);
}
