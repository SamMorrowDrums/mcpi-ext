import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import {
  SYNTHESIZED_OUTPUT_SCHEMA,
  getCodeModeDiagnostics,
  isEligibleForCodeMode,
  toCodeModeTool,
} from "./eligibility.js";

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
  it("allows explicitly read-only tools with a declared output schema", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
    });
    expect(isEligibleForCodeMode(tool)).toBe(true);
  });

  it("allows explicitly read-only tools when outputSchema is missing", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: undefined,
    });
    expect(isEligibleForCodeMode(tool)).toBe(true);
  });

  it("refuses tools when readOnlyHint is false", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: false },
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("refuses tools when readOnlyHint is missing", () => {
    const tool = makeTool({
      annotations: {},
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("refuses tools when annotations is undefined", () => {
    const tool = makeTool({
      annotations: undefined,
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });

  it("refuses destructive tools even when they claim to be read-only", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true, destructiveHint: true },
      outputSchema: { type: "object", properties: {} },
    });
    expect(isEligibleForCodeMode(tool)).toBe(false);
  });
});

describe("Code Mode catalog metadata", () => {
  it("preserves real schemas and synthesizes only for callable read-only tools", () => {
    const declaredSchema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    } as const;
    const declared = makeTool({
      name: "declared",
      annotations: { readOnlyHint: true },
      outputSchema: declaredSchema,
    });
    const synthesized = makeTool({
      name: "synthesized",
      annotations: { readOnlyHint: true },
    });
    const unavailable = makeTool({
      name: "write_tool",
      annotations: { readOnlyHint: false, destructiveHint: true },
    });

    const catalog = [declared, synthesized, unavailable].map(toCodeModeTool);

    expect(catalog[0]).toMatchObject({
      callable: true,
      outputSchemaProvenance: "declared",
    });
    expect(catalog[0].outputSchema).toBe(declaredSchema);
    expect(catalog[0].tool.outputSchema).toBe(declaredSchema);

    expect(catalog[1]).toMatchObject({
      callable: true,
      outputSchemaProvenance: "synthesized",
      outputSchema: SYNTHESIZED_OUTPUT_SCHEMA,
    });
    expect(synthesized.outputSchema).toBeUndefined();

    expect(catalog[2]).toMatchObject({
      callable: false,
      outputSchemaProvenance: "unavailable",
      refusalReasons: ["read_only_hint_required", "destructive_hint"],
    });
    expect(catalog[2].outputSchema).toBeUndefined();
    expect(unavailable).not.toHaveProperty("codeMode");

    expect(getCodeModeDiagnostics(catalog)).toEqual({
      totalTools: 3,
      callableTools: 2,
      refusedTools: 1,
      declaredOutputSchemas: 1,
      synthesizedOutputSchemas: 1,
      unavailableOutputSchemas: 1,
    });
  });
});
