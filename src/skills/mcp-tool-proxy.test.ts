import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ExtensionAPI } from "@sammorrowdrums/mcpi";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/client-manager.js";
import { McpPolicy } from "../mcp/policy.js";
import { registerMcpToolProxies } from "./mcp-tool-proxy.js";

describe("MCP tool proxy", () => {
  it("passes the complete input schema through and renders the shared terminal result", async () => {
    const inputSchema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        identifier: { type: "string", pattern: "^[a-z]+$" },
      },
      type: "object" as const,
      properties: {
        id: { $ref: "#/$defs/identifier" },
      },
      allOf: [{ required: ["id"] }],
      unevaluatedProperties: false,
    };
    const tool: McpTool = {
      name: "lookup",
      serverName: "fixture",
      inputSchema,
    };
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "found" }],
      structuredContent: false,
      isError: false,
    };
    const callTool = vi.fn().mockResolvedValue(adaptTerminalCallToolResult(protocolResult));
    const manager = {
      getTools: () => [tool],
      getConnectedServers: () => ["fixture"],
      getToolsForServer: (name: string) => (name === "fixture" ? [tool] : []),
      callTool,
      listResources: async () => [],
      readResource: async () => ({ contents: [] }),
    } as unknown as McpClientManager;
    const confirm = vi.fn().mockResolvedValue(true);
    const policy = new McpPolicy({ gateway: manager, approvals: { confirm } });
    const registered: RegisteredProxy[] = [];
    const pi = {
      getAllTools: () => [],
      registerTool: (proxy: RegisteredProxy) => registered.push(proxy),
    } as unknown as ExtensionAPI;

    expect(registerMcpToolProxies(["lookup"], manager, policy, pi)).toEqual(["lookup"]);
    expect(registered[0]?.parameters).toEqual(inputSchema);

    const rendered = await registered[0]?.execute("call-1", { id: "abc" });
    expect(callTool).toHaveBeenCalledWith("fixture", "lookup", { id: "abc" }, undefined);
    expect(rendered?.details).toBe(protocolResult);
    expect(rendered?.content).toContainEqual({
      type: "text",
      text: "Structured content:\nfalse",
    });
  });
});

interface RegisteredProxy {
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<{
    content: { type: string; text?: string }[];
    details: CallToolResult;
  }>;
}
