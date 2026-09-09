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

  it("answers discovery without entering the sandbox", async () => {
    const sandboxExecutor = vi.fn(async (): Promise<ExecuteResult> => ({
      result: ["write_records"],
      logs: [],
    }));
    const codeMode = new CodeModeManager({ sandboxExecutor });
    initCodeMode(
      codeMode,
      [makeTool("write_records", { annotations: { readOnlyHint: false } })],
      vi.fn(),
    );

    const { codeSearch } = codeMode.createTools();
    const result = await codeSearch.execute(
      "discover",
      { op: "search", query: "records" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(sandboxExecutor).not.toHaveBeenCalled();
  });

  it("indexes every tool for discovery, including tools it will not be allowed to call", () => {
    const codeMode = new CodeModeManager();
    initCodeMode(
      codeMode,
      [
        makeTool("read_records", { annotations: { readOnlyHint: true } }),
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      vi.fn(),
    );

    const listed = codeMode.discover("list", { server: "fixture" }) as {
      tools: { ref: string }[];
    };
    expect(listed.tools.map((tool) => tool.ref)).toEqual([
      "fixture/read_records",
      "fixture/write_records",
    ]);
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
      unattendedTools: 2,
      approvalGatedTools: 1,
      declaredOutputSchemas: 1,
      synthesizedOutputSchemas: 2,
      unavailableOutputSchemas: 0,
    });
    expect(
      logs.some((message) =>
        message.includes("output schemas: 1 declared, 2 synthesized, 0 unavailable"),
      ),
    ).toBe(true);

    const catalog = codeMode.getCatalogTools();
    expect(catalog[0].outputSchema).toBe(declaredSchema);
    expect(catalog[0].tool.outputSchema).toBe(declaredSchema);
    expect(catalog[1]).toMatchObject({
      runsUnattended: true,
      outputSchemaProvenance: "synthesized",
    });
    expect(catalog[1].tool.outputSchema).toBeUndefined();
    expect(catalog[2]).toMatchObject({
      runsUnattended: false,
      outputSchemaProvenance: "synthesized",
    });
    expect(tools.every((tool) => !("codeMode" in tool))).toBe(true);
  });

  it("marks a declared output schema as typed and an absent one as unknown", () => {
    const codeMode = new CodeModeManager();
    initCodeMode(
      codeMode,
      [
        makeTool("declared_read", {
          annotations: { readOnlyHint: true },
          outputSchema: { type: "object", properties: { total: { type: "number" } } },
        }),
        makeTool("schema_less_read", { annotations: { readOnlyHint: true } }),
      ],
      vi.fn(),
    );

    const described = codeMode.discover("describe", {
      refs: ["fixture/declared_read", "fixture/schema_less_read"],
    }) as { signatures: { ref: string; signature: string }[] };

    const declared = described.signatures[0].signature;
    const undeclared = described.signatures[1].signature;

    expect(declared).toContain("total");
    // No schema means no claim about the shape. The model is told to look,
    // rather than handed a fabricated type it might trust.
    expect(undeclared).toContain("unknown");
    expect(undeclared).toContain("codemode.inspect");
  });

  it("pins the system prompt section across catalog changes", () => {
    const codeMode = new CodeModeManager();
    const manager = fakeManager(
      [makeTool("read_records", { annotations: { readOnlyHint: true } })],
      vi.fn(),
    );
    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));

    const pinned = codeMode.formatSystemPromptSection();
    const before = codeMode.getSnapshot().snapshotId;

    // A server connects mid-session and publishes 40 more tools.
    const grown = [
      makeTool("read_records", { annotations: { readOnlyHint: true } }),
      ...Array.from({ length: 40 }, (_, index) =>
        makeTool(`late_tool_${String(index)}`, {
          serverName: "late-server",
          annotations: { readOnlyHint: true },
        }),
      ),
    ];
    const grownManager = fakeManager(grown, vi.fn());
    codeMode.initialize(grownManager, new McpPolicy({ gateway: grownManager }));

    expect(codeMode.getSnapshot().snapshotId).not.toBe(before);
    // The prompt does not move: rewriting it would invalidate the provider
    // prefix cache for every remaining turn.
    expect(codeMode.formatSystemPromptSection()).toBe(pinned);
    // But the late server is fully reachable through discovery.
    const found = codeMode.discover("search", { query: "late_tool_7" }) as {
      hits: { ref: string }[];
    };
    expect(found.hits[0].ref).toBe("late-server/late_tool_7");
  });

  it("refuses an ambiguous bare tool name instead of guessing a server", async () => {
    const callTool = vi.fn();
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("list_issues", { serverName: "github", annotations: { readOnlyHint: true } }),
        makeTool("list_issues", { serverName: "gitlab", annotations: { readOnlyHint: true } }),
      ],
      callTool,
    );

    const result = await codeMode.executeCode(`return await codemode.callRef("list_issues", {});`);

    expect(result.errorDetails?.error).toBe("ambiguous_tool");
    expect(result.errorDetails?.candidates).toEqual(["github/list_issues", "gitlab/list_issues"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("surfaces a policy denial as a structured failure rather than a text success", async () => {
    const callTool = vi.fn(async () =>
      adaptTerminalCallToolResult({ content: [{ type: "text", text: "closed" }] }),
    );
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      callTool,
      true,
    );

    const denied = await codeMode.executeCode(
      'return await codemode.call("fixture", "write_records", { value: "unsafe" });',
    );

    expect(denied.result).toBeUndefined();
    expect(denied.errorDetails?.error).toBe("permission_denied");
    expect(denied.errorDetails?.toolName).toBe("write_records");
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

  it("forwards host cancellation into the policy call", async () => {
    const controller = new AbortController();
    const callTool = vi.fn(async () => adaptTerminalCallToolResult({ content: [] }));
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [makeTool("schema_less_read", { annotations: { readOnlyHint: true } })],
      callTool,
    );

    await codeMode.executeCode("return await codemode.schema_less_read({});", controller.signal);

    expect(callTool).toHaveBeenCalledWith("fixture", "schema_less_read", {}, controller.signal);
  });
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
  approval?: boolean,
): McpPolicy {
  const manager = fakeManager(tools, callTool);
  const policy = new McpPolicy({
    gateway: manager,
    ...(approval === undefined ? {} : { approvals: { confirm: async () => approval } }),
  });
  codeMode.initialize(manager, policy);
  return policy;
}
