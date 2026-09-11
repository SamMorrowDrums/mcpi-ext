import type { CallToolResult } from "@modelcontextprotocol/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@sammorrowdrums/mcpi";
import { describe, expect, it, vi } from "vitest";
import { CodeModeManager } from "../code-mode/index.js";
import type { ExecuteResult, SandboxRequest } from "../code-mode/executor.js";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/client-manager.js";
import { McpPolicy } from "../mcp/policy.js";
import { createPolicyToolProvider } from "../tool-cli/provider.js";
import { isDirectMcpResultOffloadDetails } from "./direct-result-offload.js";
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

  it("offloads a job-log-shaped direct result without changing Code Mode or tool-cli", async () => {
    const output = Array.from(
      { length: 120 },
      (_, index) => `job-${index}: ${"log payload ".repeat(18)}`,
    ).join("\n");
    expect(Buffer.byteLength(output)).toBeGreaterThan(20_000);
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: output }],
      _meta: { requestId: "job-log-1" },
    };
    const smallProtocolResult: CallToolResult = {
      content: [{ type: "text", text: "https://github.example/actions/runs/123/job/456" }],
      _meta: { requestId: "job-log-url-1" },
    };
    const tool: McpTool = {
      name: "get_job_logs",
      serverName: "github",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true },
    };
    const callTool = vi.fn(async (_server: string, _tool: string, args: Record<string, unknown>) =>
      adaptTerminalCallToolResult(
        args.return_content === false ? smallProtocolResult : protocolResult,
      ),
    );
    const manager = fakeManager(tool, callTool);
    const policy = new McpPolicy({ gateway: manager });
    const registered: RegisteredProxy[] = [];
    const pi = {
      getAllTools: () => [],
      registerTool: (proxy: RegisteredProxy) => registered.push(proxy),
    } as unknown as ExtensionAPI;
    const sessionDirectory = resolve(".mcpi-test-artifacts", "proxy-integration", randomUUID());

    try {
      registerMcpToolProxies(["get_job_logs"], manager, policy, pi);
      const direct = await registered[0]?.execute(
        "call-job-logs",
        { return_content: true, tail_lines: 120 },
        undefined,
        undefined,
        makeContext(sessionDirectory),
      );
      if (!direct || !isDirectMcpResultOffloadDetails(direct.details)) {
        throw new Error("Expected direct proxy result to be offloaded");
      }
      expect(await readFile(direct.details.output.path, "utf8")).toBe(output);
      expect(direct.details.output.sha256).toBe(createHash("sha256").update(output).digest("hex"));

      const smallDirect = await registered[0]?.execute(
        "call-job-logs-url",
        { return_content: false },
        undefined,
        undefined,
        makeContext(sessionDirectory),
      );
      expect(smallDirect?.details).toBe(smallProtocolResult);
      expect(smallDirect?.content).toEqual(smallProtocolResult.content);

      const codeMode = new CodeModeManager({
        sandboxExecutor: async (request: SandboxRequest): Promise<ExecuteResult> => ({
          result: await request.dispatch(
            { kind: "identity", serverName: "github", toolName: "get_job_logs" },
            { return_content: true, tail_lines: 120 },
          ),
          logs: [],
        }),
      });
      codeMode.initialize(manager, policy);
      const viaCodeMode = await codeMode.executeCode("return raw result");
      expect(viaCodeMode.result).toEqual(protocolResult);

      const provider = createPolicyToolProvider(policy);
      const viaToolCli = await provider.callTool("github", "get_job_logs", {
        return_content: true,
        tail_lines: 120,
      });
      expect(viaToolCli).toEqual(protocolResult);

      const resultDirectory = resolve(sessionDirectory, "mcpi-ext-results", "session-test");
      expect((await readdir(resultDirectory)).filter((name) => name.endsWith(".txt"))).toHaveLength(
        1,
      );
    } finally {
      await rm(sessionDirectory, { recursive: true, force: true });
    }
  });
});

interface RegisteredProxy {
  parameters: unknown;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: ExtensionContext,
  ): Promise<{
    content: { type: string; text?: string }[];
    details: unknown;
  }>;
}

function fakeManager(tool: McpTool, callTool: ReturnType<typeof vi.fn>): McpClientManager {
  return {
    getTools: () => [tool],
    getConnectedServers: () => [tool.serverName],
    getToolsForServer: (name: string) => (name === tool.serverName ? [tool] : []),
    callTool,
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClientManager;
}

function makeContext(sessionDirectory: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionDir: () => sessionDirectory,
      getSessionId: () => "session-test",
    },
  } as unknown as ExtensionContext;
}
