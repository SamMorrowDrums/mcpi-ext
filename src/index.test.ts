import { describe, expect, it, vi } from "vitest";

interface RegisteredTool {
  name: string;
  execute?: (
    toolCallId: string,
    params: { code: string },
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: unknown,
  ) => Promise<{
    content: { type: string; text?: string }[];
    details: Record<string, unknown>;
  }>;
}

describe("mcpi-ext", () => {
  it("exports a default function", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.default).toBe("function");
  });

  it("reports bash available only when it is active", async () => {
    const { detectBashState } = await import("./index.js");
    const active = {
      getActiveTools: () => ["bash", "code_execute"],
    } as unknown as Parameters<typeof detectBashState>[0];
    const disabled = {
      getActiveTools: () => ["code_execute"],
      getAllTools: () => [{ name: "bash" }],
    } as unknown as Parameters<typeof detectBashState>[0];

    expect(detectBashState(active)).toEqual({ kind: "registered", toolName: "bash" });
    expect(detectBashState(disabled)).toEqual({ kind: "absent" });
  });

  it("does not mistake an unavailable active-tool registry for absent bash", async () => {
    const { detectBashState } = await import("./index.js");
    const pi = {
      getActiveTools: () => {
        throw new Error("active tools unavailable");
      },
    } as unknown as Parameters<typeof detectBashState>[0];

    expect(detectBashState(pi)).toEqual({
      kind: "undiscoverable",
      reason: "active tools unavailable",
    });
  });

  it("registers code tools before any MCP servers connect and executes pure computation", async () => {
    const { default: registerExtension } = await import("./index.js");
    const registeredTools: RegisteredTool[] = [];
    const pi = {
      registerTool: vi.fn((tool: unknown) => registeredTools.push(tool as RegisteredTool)),
      registerFlag: vi.fn(),
      on: vi.fn(),
      getFlag: vi.fn(),
      setEnv: vi.fn(),
      unsetEnv: vi.fn(),
    } as unknown as Parameters<typeof registerExtension>[0];

    registerExtension(pi);

    const codeExecute = registeredTools.find((tool) => tool.name === "code_execute");
    const codeSearch = registeredTools.find((tool) => tool.name === "code_search");
    expect(codeExecute?.execute).toBeTypeOf("function");
    expect(codeSearch?.execute).toBeTypeOf("function");

    const execution = await codeExecute?.execute?.(
      "call-1",
      {
        code: `return {
          total: [7, 11, 13].reduce((sum, value) => sum + value, 0),
          parsed: JSON.parse('{"ok":true}').ok
        };`,
      },
      undefined,
      undefined,
      {},
    );
    expect(execution?.content[0]).toEqual({
      type: "text",
      text: '{\n  "total": 31,\n  "parsed": true\n}',
    });

    const nullExecution = await codeExecute?.execute?.(
      "call-null",
      { code: "return null;" },
      undefined,
      undefined,
      {},
    );
    expect(nullExecution?.content[0]).toEqual({ type: "text", text: "null" });

    const search = await codeSearch?.execute?.(
      "call-2",
      // The registry array is heterogeneous, so `find` narrows to the first
      // tool's parameter type rather than code_search's.
      { op: "browse" } as unknown as { code: string },
      undefined,
      undefined,
      {},
    );
    // Discovery answers honestly from an empty catalog rather than erroring.
    expect(search?.details).toMatchObject({ op: "browse" });
    expect(search?.content[0]).toEqual({
      type: "text",
      text: "No MCP namespaces are available. No servers are connected, or none expose callable tools.",
    });
  });
});
