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
      { code: "return await codemode.listTools();" },
      undefined,
      undefined,
      {},
    );
    expect(search?.details).toMatchObject({
      error: "no_eligible_tools",
      alternatives: ["code_execute", "tool-cli"],
    });
  });
});
