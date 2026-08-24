import type { ToolProvider } from "@sammorrowdrums/tool-cli/server";
import { toToolCliCallToolResult } from "../mcp/call-tool-result.js";
import type { McpPolicy } from "../mcp/policy.js";

/**
 * Bridge the shared MCP policy boundary to tool-cli's `ToolProvider` interface.
 *
 * tool-cli's RPC server derives `listTools` and `describeTool` from
 * `getTools`, so restricting discovery here restricts what the CLI can learn.
 * More importantly, `callTool` does not check membership against the
 * discovered set before forwarding, which means a caller can name a tool the
 * CLI never advertised. Routing every call back through {@link McpPolicy}
 * closes that gap: the same dispatcher that gates the proxy and Code Mode
 * paths re-authorizes each RPC call, so naming a hidden tool is refused before
 * the upstream server is contacted.
 */
export function createPolicyToolProvider(policy: McpPolicy): ToolProvider {
  return {
    getServerNames: () => policy.getVisibleServers(),
    getTools: (server) => policy.getVisibleTools(server),
    async callTool(server, tool, args) {
      const terminal = await policy.callTool({
        source: "tool-cli",
        serverName: server,
        toolName: tool,
        args,
      });
      return toToolCliCallToolResult(terminal);
    },
  };
}
