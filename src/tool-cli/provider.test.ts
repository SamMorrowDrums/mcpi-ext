import type { ReadResourceResult, Resource } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpTool } from "../mcp/client-manager.js";
import { noSkillsExtensionGateway } from "../mcp/gateway-defaults.js";
import { McpPolicy, type McpPolicyGateway } from "../mcp/policy.js";
import { ToolCliServer } from "./index.js";
import { createPolicyToolProvider } from "./provider.js";

const PROTOCOL_RESULT = {
  content: [{ type: "text" as const, text: "sunny" }],
  structuredContent: { temp: 21 },
};

const emptySchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object" as const,
  properties: {},
};

function tool(name: string, readOnly: boolean): McpTool {
  return {
    name,
    serverName: "alpha",
    inputSchema: emptySchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly },
  };
}

const visibleTool = tool("read_weather", true);
const gatedTool = tool("secret_probe", true);

const servers: ToolCliServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
});

async function startBridge(options: { gate?: boolean } = {}) {
  const upstream = vi
    .fn<(...args: unknown[]) => Promise<ReturnType<typeof adaptTerminalCallToolResult>>>()
    .mockResolvedValue(adaptTerminalCallToolResult(PROTOCOL_RESULT));

  const gateway: McpPolicyGateway = {
    ...noSkillsExtensionGateway,
    getConnectedServers: () => ["alpha"],
    getToolsForServer: () => [visibleTool, gatedTool],
    callTool: upstream as unknown as McpPolicyGateway["callTool"],
    listResources: (): Promise<Resource[]> => Promise.resolve([]),
    readResource: (): Promise<ReadResourceResult> => Promise.resolve({ contents: [] }),
  };

  const policy = new McpPolicy({ gateway });
  if (options.gate !== false) {
    policy.registerSkills([
      {
        name: "probe",
        uri: "skill://probe/SKILL.md",
        serverName: "alpha",
        allowedTools: ["secret_probe"],
      },
    ]);
  }

  const server = new ToolCliServer(createPolicyToolProvider(policy));
  servers.push(server);
  const { port, token } = await server.start(() => undefined);

  const rpc = async (method: string, params: unknown): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  return { policy, upstream, rpc, port, token };
}

describe("tool-cli policy bridge", () => {
  it("advertises exactly the policy-visible discovered schema set", async () => {
    const { rpc } = await startBridge();

    const response = await rpc("listTools", { server: "alpha" });
    const result = response.result as { tools: { name: string }[] };

    expect(result.tools.map((entry) => entry.name)).toEqual(["read_weather"]);
  });

  it("hides a gated tool from describeTool", async () => {
    const { rpc } = await startBridge();

    const response = await rpc("describeTool", { server: "alpha", tool: "secret_probe" });

    expect(response.error).toBeDefined();
  });

  it("refuses a direct authenticated call that names a hidden tool", async () => {
    const { rpc, upstream } = await startBridge();

    const response = await rpc("callTool", { server: "alpha", tool: "secret_probe", args: {} });

    expect(response.error).toBeDefined();
    expect(JSON.stringify(response.error)).toContain("load_skill");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a direct authenticated call that names an undiscovered tool", async () => {
    const { rpc, upstream } = await startBridge();

    const response = await rpc("callTool", { server: "alpha", tool: "ghost", args: {} });

    expect(response.error).toBeDefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("refuses a direct authenticated call to another server origin", async () => {
    const { rpc, upstream } = await startBridge();

    const response = await rpc("callTool", { server: "beta", tool: "read_weather", args: {} });

    expect(response.error).toBeDefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("crosses the dispatcher exactly once for an allowed call", async () => {
    const { rpc, upstream, policy } = await startBridge();

    const response = await rpc("callTool", { server: "alpha", tool: "read_weather", args: {} });

    expect(response.error).toBeUndefined();
    expect(upstream).toHaveBeenCalledTimes(1);

    const audit = policy.getAuditLog();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      source: "tool-cli",
      operation: "tool",
      toolName: "read_weather",
      decision: "allowed",
    });
  });

  it("exposes no resource RPC surface, so skill:// reads are unreachable", async () => {
    const { rpc } = await startBridge();

    const readResource = await rpc("readResource", {
      server: "alpha",
      uri: "skill://probe/SKILL.md",
    });
    const listResources = await rpc("listResources", { server: "alpha" });

    expect(readResource.error).toBeDefined();
    expect(listResources.error).toBeDefined();
  });

  it("rejects unauthenticated calls before reaching the policy", async () => {
    const { upstream, port } = await startBridge();

    const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "callTool",
        params: { server: "alpha", tool: "read_weather", args: {} },
      }),
    });

    expect(response.ok).toBe(false);
    expect(upstream).not.toHaveBeenCalled();
  });
});
