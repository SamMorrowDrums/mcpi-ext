import type { McpTool } from "./client-manager.js";

/**
 * A tool call is treated as read-only only when the server explicitly declares
 * it read-only and does not also declare it destructive.
 */
export function isReadOnlyToolCall(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}
