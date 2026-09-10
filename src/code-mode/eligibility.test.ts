import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import {
  SYNTHESIZED_OUTPUT_SCHEMA,
  getCodeModeDiagnostics,
  runsUnattendedInCodeMode,
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

describe("runsUnattendedInCodeMode", () => {
  it("allows explicitly read-only tools with a declared output schema", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: { type: "object", properties: { result: { type: "string" } } },
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(true);
  });

  it("allows explicitly read-only tools when outputSchema is missing", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true },
      outputSchema: undefined,
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(true);
  });

  it("refuses tools when readOnlyHint is false", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: false },
      outputSchema: { type: "object", properties: {} },
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(false);
  });

  it("refuses tools when readOnlyHint is missing", () => {
    const tool = makeTool({
      annotations: {},
      outputSchema: { type: "object", properties: {} },
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(false);
  });

  it("refuses tools when annotations is undefined", () => {
    const tool = makeTool({
      annotations: undefined,
      outputSchema: { type: "object", properties: {} },
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(false);
  });

  it("refuses destructive tools even when they claim to be read-only", () => {
    const tool = makeTool({
      annotations: { readOnlyHint: true, destructiveHint: true },
      outputSchema: { type: "object", properties: {} },
    });
    expect(runsUnattendedInCodeMode(tool)).toBe(false);
  });
});

describe("Code Mode catalog metadata", () => {
  it("preserves declared schemas and synthesizes one for every other tool", () => {
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
    const gated = makeTool({
      name: "write_tool",
      annotations: { readOnlyHint: false, destructiveHint: true },
    });

    const catalog = [declared, synthesized, gated].map(toCodeModeTool);

    expect(catalog[0]).toMatchObject({
      runsUnattended: true,
      outputSchemaProvenance: "declared",
    });
    expect(catalog[0].outputSchema).toBe(declaredSchema);
    expect(catalog[0].tool.outputSchema).toBe(declaredSchema);

    expect(catalog[1]).toMatchObject({
      runsUnattended: true,
      outputSchemaProvenance: "synthesized",
      outputSchema: SYNTHESIZED_OUTPUT_SCHEMA,
    });
    expect(synthesized.outputSchema).toBeUndefined();

    // A write tool is as typeable as a read tool. It pauses for approval when
    // it runs; that is not a reason to leave the model guessing at its shape.
    expect(catalog[2]).toMatchObject({
      runsUnattended: false,
      outputSchemaProvenance: "synthesized",
      outputSchema: SYNTHESIZED_OUTPUT_SCHEMA,
      approvalReasons: ["not_annotated_read_only", "destructive_hint"],
    });
    expect(gated).not.toHaveProperty("codeMode");

    expect(getCodeModeDiagnostics(catalog)).toEqual({
      totalTools: 3,
      unattendedTools: 2,
      approvalGatedTools: 1,
      declaredOutputSchemas: 1,
      synthesizedOutputSchemas: 2,
      unavailableOutputSchemas: 0,
    });
  });
});
