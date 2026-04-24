import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { McpClientManager, McpTool } from "../mcp/index.js";

interface McpToolProxyDetails {
  serverName: string;
  toolName: string;
  error?: string;
}

/**
 * Register MCP tools as Pi tool proxies.
 *
 * Each registered tool forwards calls to the MCP server via `client.callTool()`.
 * Uses a permissive TypeBox schema (Record<string, unknown>) since the real
 * validation happens on the MCP server side.
 */
export function registerMcpToolProxies(
  toolNames: string[],
  mcpManager: McpClientManager,
  pi: ExtensionAPI,
): string[] {
  const registered: string[] = [];
  const allTools = mcpManager.getTools();

  // Check which tools are already registered to avoid double-registration
  const existingTools = new Set(pi.getAllTools().map((t: { name: string }) => t.name));

  for (const name of toolNames) {
    if (existingTools.has(name)) {
      registered.push(name);
      continue;
    }

    const mcpTool = allTools.find((t) => t.name === name);
    if (!mcpTool) continue;

    pi.registerTool(createMcpToolProxy(mcpTool, mcpManager));
    registered.push(name);
  }

  return registered;
}

function createMcpToolProxy(mcpTool: McpTool, mcpManager: McpClientManager) {
  // Pass through the MCP tool's JSON Schema directly via Type.Unsafe()
  // This preserves the original property names and types for the model
  const inputSchema = mcpTool.inputSchema;
  const parameters = Type.Unsafe({
    type: "object",
    properties: (inputSchema.properties as Record<string, unknown>) ?? {},
    required: (inputSchema.required as string[]) ?? [],
  });

  return {
    name: mcpTool.name,
    label: mcpTool.name,
    description: mcpTool.description ?? `MCP tool from ${mcpTool.serverName}`,
    parameters,

    async execute(
      _toolCallId: string,
      params: Record<string, unknown>,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<McpToolProxyDetails>> {
      const client = mcpManager.getClient(mcpTool.serverName);
      if (!client) {
        return {
          content: [
            {
              type: "text",
              text: `MCP server "${mcpTool.serverName}" is not connected.`,
            },
          ],
          details: {
            serverName: mcpTool.serverName,
            toolName: mcpTool.name,
            error: "disconnected",
          },
        };
      }

      try {
        const result = await client.callTool({
          name: mcpTool.name,
          arguments: params,
        });

        const content = Array.isArray(result.content)
          ? result.content.map((c) => {
              if (typeof c === "object" && c !== null && "type" in c && "text" in c) {
                return { type: "text" as const, text: String(c.text) };
              }
              return { type: "text" as const, text: JSON.stringify(c) };
            })
          : [{ type: "text" as const, text: JSON.stringify(result) }];

        return {
          content,
          details: { serverName: mcpTool.serverName, toolName: mcpTool.name },
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `MCP tool "${mcpTool.name}" failed: ${(err as Error).message}`,
            },
          ],
          details: {
            serverName: mcpTool.serverName,
            toolName: mcpTool.name,
            error: (err as Error).message,
          },
        };
      }
    },
  };
}
