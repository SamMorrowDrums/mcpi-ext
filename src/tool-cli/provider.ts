import type {
  ResourceInfo,
  ResourceTemplateInfo,
  ReadResourceResult as ToolCliReadResourceResult,
  ToolInfo,
  ToolProvider,
  UpstreamMcpSummary,
} from "@sammorrowdrums/tool-cli/server";
import { toToolCliCallToolResult } from "../mcp/call-tool-result.js";
import { MCP_CLIENT_IDENTITY } from "../mcp/client-factory.js";
import type { McpClientManager, McpTool } from "../mcp/client-manager.js";
import type { McpPolicy } from "../mcp/policy.js";

export interface PolicyToolProviderOptions {
  upstream?: Pick<McpClientManager, "getConnectedServers" | "getToolsForServer" | "getDiagnostics">;
}

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
export function createPolicyToolProvider(
  policy: McpPolicy,
  options: PolicyToolProviderOptions = {},
): ToolProvider {
  const provider: ToolProvider = {
    getServerNames: () => policy.getVisibleServers(),
    getTools: (server) => policy.getVisibleTools(server).map(toToolInfo),
    async callTool(server, tool, args, context) {
      const terminal = await policy.callTool({
        source: "tool-cli",
        serverName: server,
        toolName: tool,
        args,
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      });
      return toToolCliCallToolResult(terminal);
    },
    async listResources(server, context) {
      const resources = await policy.listResources({
        source: "tool-cli",
        serverName: server,
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      });
      return resources.map((resource): ResourceInfo => ({ ...resource }));
    },
    async listResourceTemplates(server, context) {
      const templates = await policy.listResourceTemplates({
        source: "tool-cli",
        serverName: server,
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      });
      return templates.map((template): ResourceTemplateInfo => ({ ...template }));
    },
    async readResource(server, uri, context) {
      const result = await policy.readResource({
        source: "tool-cli",
        serverName: server,
        uri,
        ...(context?.signal !== undefined ? { signal: context.signal } : {}),
      });
      return {
        ...result,
        contents: result.contents.map((content) => ({ ...content })),
      } satisfies ToolCliReadResourceResult;
    },
  };

  const upstream = options.upstream;
  if (upstream !== undefined) {
    provider.getUpstreamMcpSummary = () => buildUpstreamMcpSummary(upstream);
  }

  return provider;
}

/** Build a deterministic bridge summary from the manager's live per-server diagnostics. */
export function buildUpstreamMcpSummary(
  upstream: NonNullable<PolicyToolProviderOptions["upstream"]>,
): UpstreamMcpSummary {
  const servers = upstream
    .getConnectedServers()
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => {
      const diagnostics = upstream.getDiagnostics(name);
      return {
        name,
        toolCount: upstream.getToolsForServer(name).length,
        ...(diagnostics?.protocolVersion !== undefined
          ? { protocolVersion: diagnostics.protocolVersion }
          : {}),
        ...(diagnostics?.protocolEra !== undefined ? { protocolEra: diagnostics.protocolEra } : {}),
        ...(diagnostics?.serverImplementation !== undefined
          ? { implementation: diagnostics.serverImplementation }
          : {}),
        ...(diagnostics?.serverCapabilities !== undefined
          ? { capabilities: diagnostics.serverCapabilities }
          : {}),
        ...(diagnostics?.discoverResult !== undefined
          ? { discoverResult: diagnostics.discoverResult }
          : {}),
        ...(diagnostics !== undefined ? { skillsExtension: diagnostics.skillsExtension } : {}),
      };
    });

  const protocolVersions = [
    ...new Set(
      servers.flatMap((server) =>
        server.protocolVersion !== undefined ? [server.protocolVersion] : [],
      ),
    ),
  ];

  return {
    ...(protocolVersions.length === 1 ? { protocolVersion: protocolVersions[0] } : {}),
    implementation: { ...MCP_CLIENT_IDENTITY },
    capabilities: {
      multiplexedServers: true,
      tools: {
        serverCount: servers.filter((server) => server.toolCount > 0).length,
      },
      resources: {
        serverCount: servers.filter((server) => server.capabilities?.resources !== undefined)
          .length,
      },
    },
    serverCount: servers.length,
    servers,
  };
}

function toToolInfo(tool: McpTool): ToolInfo {
  const info = { ...tool };
  Reflect.deleteProperty(info, "serverName");
  return info;
}
