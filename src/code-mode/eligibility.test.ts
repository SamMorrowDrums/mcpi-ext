import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { isEligibleForCodeMode } from "./eligibility.js";

function makeTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    serverName: "test-server",
    ...overrides,
  };
}

describe("isEligibleForCodeMode", () => {
  it("returns true when readOnlyHint is true and outputSchema is defined", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
    });
    expect(isEligibleForCodeMode(tool)).toBe(true);
  });

  it("returns false when readOnlyHint is false", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: false },
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("returns false when readOnlyHint is missing", () => {
    const tool = makeTool({
      annotations: {},
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("returns false when annotations is undefined", () => {
    const tool = makeTool({
      annotations: undefined,
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("returns false when outputSchema is missing", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: undefined,
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("returns false when both readOnlyHint and outputSchema are missing", () => {
    const tool = makeTool();
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });
});
