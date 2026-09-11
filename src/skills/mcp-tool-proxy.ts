import type { ExtensionAPI, ExtensionContext } from "@sammorrowdrums/mcpi";
import { Type } from "typebox";
import type { McpClientManager, McpTool } from "../mcp/client-manager.js";
import type { ServerTrust } from "../mcp/config.js";
import type { McpPolicy } from "../mcp/policy.js";
import { renderDirectMcpProxyResult } from "./direct-result-offload.js";

/**
 * Register MCP tools as deferred mcpi proxies backed by the shared policy boundary.
 */
export function registerMcpToolProxies(
  toolNames: string[],
  manager: McpClientManager,
  policy: McpPolicy,
  pi: ExtensionAPI,
  trustByServer?: Readonly<Record<string, ServerTrust>>,
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
    pi.registerTool(
      createMcpToolProxy(policy, tool, trustByServer?.[tool.serverName] ?? "untrusted"),
    );
    registered.push(name);
  }

  return registered;
}

function createMcpToolProxy(policy: McpPolicy, tool: McpTool, trust: ServerTrust) {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description ?? `MCP tool from ${tool.serverName}`,
    deferred: true,
    parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema),
    async execute(
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      _onUpdate?: unknown,
      context?: ExtensionContext,
    ) {
      const terminal = await policy.callTool({
        source: "proxy",
        serverName: tool.serverName,
        toolName: tool.name,
        args: params,
        ...(signal ? { signal } : {}),
      });
      return renderDirectMcpProxyResult(terminal, {
        serverName: tool.serverName,
        toolName: tool.name,
        toolCallId,
        ...(context ? { context } : {}),
        trust,
      });
    },
  };
}
