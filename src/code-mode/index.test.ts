import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicy } from "../mcp/policy.js";
import type { ExecuteResult } from "./executor.js";
import { CodeModeManager } from "./index.js";

const structuredValues: CallToolResult["structuredContent"][] = [
  false,
  0,
  "",
  null,
  [],
  { nested: ["value"] },
];

describe("CodeModeManager reliability", () => {
  it("runs pure deterministic computation without an MCP manager", async () => {
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });

    const result = await codeMode.executeCode(`
      const parsed = JSON.parse('{"values":[3,5,8]}');
      return parsed.values.map((value) => value * 2);
    `);

    expect(result).toEqual({ result: [6, 10, 16], logs: [] });
    expect(codeMode.isActive).toBe(true);
  });

  it("refuses code_search before isolate entry when no callable tools exist", async () => {
    const sandboxExecutor = vi.fn(async (): Promise<ExecuteResult> => ({
      result: "unexpected",
      logs: [],
    }));
    const codeMode = new CodeModeManager({ sandboxExecutor });
    initCodeMode(
      codeMode,
      [
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      vi.fn(),
    );

    const result = await codeMode.searchTools("return await codemode.listTools();");

    expect(result.errorDetails).toEqual({
      error: "no_eligible_tools",
      message: "code_search has no callable read-only MCP tools to search.",
      alternatives: ["code_execute", "tool-cli"],
    });
    expect(codeMode.getTypeHints()).toContain("write_records:");
    expect(sandboxExecutor).not.toHaveBeenCalled();
  });

  it("keeps declared and synthesized schema provenance distinct without mutating tools", () => {
    const declaredSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    } as const;
    const tools: McpTool[] = [
      makeTool("declared_read", {
        annotations: { readOnlyHint: true },
        outputSchema: declaredSchema,
      }),
      makeTool("schema_less_read", {
        annotations: { readOnlyHint: true },
      }),
      makeTool("write_records", {
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ];
    const logs: string[] = [];
    const codeMode = new CodeModeManager({ log: (message) => logs.push(message) });
    initCodeMode(codeMode, tools, vi.fn());

    expect(codeMode.getDiagnostics()).toEqual({
      totalTools: 3,
      callableTools: 2,
      refusedTools: 1,
      declaredOutputSchemas: 1,
      synthesizedOutputSchemas: 1,
      unavailableOutputSchemas: 1,
    });
    expect(
      logs.some((message) =>
        message.includes("output schemas: 1 declared, 1 synthesized, 1 unavailable"),
      ),
    ).toBe(true);

    const catalog = codeMode.getCatalogTools();
    expect(catalog[0].outputSchema).toBe(declaredSchema);
    expect(catalog[0].tool.outputSchema).toBe(declaredSchema);
    expect(catalog[1]).toMatchObject({
      callable: true,
      outputSchemaProvenance: "synthesized",
    });
    expect(catalog[1].tool.outputSchema).toBeUndefined();
    expect(catalog[2]).toMatchObject({
      callable: false,
      outputSchemaProvenance: "unavailable",
    });
    expect(tools.every((tool) => !("codeMode" in tool))).toBe(true);

    const hints = codeMode.getTypeHints();
    expect(hints).toContain("MCP catalog: 3 tool(s); 2 callable, 1 dispatch-refused");
    expect(hints).toContain("Output schemas: 1 declared, 1 synthesized, 1 unavailable");
    expect(hints).toContain("declared_read:");
    expect(hints).toContain("schema_less_read:");
    expect(hints).toContain("write_records:");
  });

  it("lists non-read-only tools but refuses dispatch without invoking MCP", async () => {
    const callTool = vi.fn(async () =>
      adaptTerminalCallToolResult({ content: [{ type: "text", text: "should not run" }] }),
    );
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("schema_less_read", { annotations: { readOnlyHint: true } }),
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      callTool,
    );

    const discovery = await codeMode.searchTools("return await codemode.listTools();");
    expect(discovery.result).toEqual(["schema_less_read", "write_records"]);

    const denied = await codeMode.executeCode(
      'return await codemode.write_records({ value: "unsafe" });',
    );
    expect(denied.errorDetails).toEqual({
      error: "permission_denied",
      message:
        'Tool "write_records" is visible for discovery but cannot be called from Code Mode. ' +
        "Use load_skill or tool-cli through the host's permission-aware path.",
      alternatives: ["load_skill", "tool-cli"],
      toolName: "write_records",
      reason: "annotations.readOnlyHint is not true; annotations.destructiveHint is true",
    });

    const toolResult = await codeMode
      .createTools()
      .codeExecute.execute(
        "unsafe-call",
        { code: 'return await codemode.write_records({ value: "unsafe" });' },
        undefined,
        undefined,
        {} as never,
      );
    expect(toolResult.details).toMatchObject({
      error: "permission_denied",
      alternatives: ["load_skill", "tool-cli"],
      toolName: "write_records",
    });
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(structuredValues)(
    "preserves terminal structuredContent through synthesized-schema dispatch: %j",
    async (structuredContent) => {
      const protocolResult: CallToolResult = { content: [], structuredContent };
      const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
      const codeMode = new CodeModeManager({ timeoutMs: 5000 });
      initCodeMode(
        codeMode,
        [makeTool("schema_less_read", { annotations: { readOnlyHint: true } })],
        callTool,
      );

      const result = await codeMode.executeCode(`
        const terminal = await codemode.schema_less_read({});
        return terminal.structuredContent;
      `);

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(structuredContent);
      expect(callTool).toHaveBeenCalledWith("fixture", "schema_less_read", {}, undefined);
    },
  );
});

function makeTool(name: string, overrides: Partial<McpTool> = {}): McpTool {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    serverName: "fixture",
    ...overrides,
  };
}

function fakeManager(tools: McpTool[], callTool: ReturnType<typeof vi.fn>): McpClientManager {
  return {
    getTools: () => tools,
    getConnectedServers: () => [...new Set(tools.map((t) => t.serverName))],
    getToolsForServer: (name: string) => tools.filter((t) => t.serverName === name),
    callTool,
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClientManager;
}

/** Wire a fake manager through the real policy, mirroring production wiring. */
function initCodeMode(
  codeMode: CodeModeManager,
  tools: McpTool[],
  callTool: ReturnType<typeof vi.fn>,
): McpPolicy {
  const manager = fakeManager(tools, callTool);
  const policy = new McpPolicy({ gateway: manager });
  codeMode.initialize(manager, policy);
  return policy;
}
