import type { ExtensionAPI } from "@sammorrowdrums/mcpi";
import { Type } from "typebox";
import { renderTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/client-manager.js";

/**
 * Register MCP tools as deferred mcpi proxies backed by the central client seam.
 */
export function registerMcpToolProxies(
  toolNames: string[],
  manager: McpClientManager,
  pi: ExtensionAPI,
): string[] {
  const registered: string[] = [];
  const existingTools = new Set(pi.getAllTools().map((tool) => tool.name));
  const toolsByName = new Map(manager.getTools().map((tool) => [tool.name, tool]));

  for (const name of toolNames) {
    if (existingTools.has(name)) {
      registered.push(name);
      continue;
    }

    const tool = toolsByName.get(name);
    if (!tool) continue;
    pi.registerTool(createMcpToolProxy(manager, tool));
    registered.push(name);
  }

  return registered;
}

function createMcpToolProxy(manager: McpClientManager, tool: McpTool) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? `MCP tool from ${tool.serverName}`,
    deferred: true,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const terminal = await manager.callTool(tool.serverName, tool.name, params);
      return renderTerminalCallToolResult(terminal);
    },
  };
}
