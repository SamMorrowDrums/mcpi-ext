import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import {
  SYNTHESIZED_OUTPUT_SCHEMA,
  getCodeModeDiagnostics,
  toCodeModeTool,
} from "./eligibility.js";
import { isReadOnlyToolCall } from "../mcp/policy.js";

function makeTool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: "test_tool",
    description: "A test tool",
    inputSchema: { type: "object", properties: {} },
    serverName: "test-server",
    ...overrides,
  };
}

/**
 * Code Mode used to carry its own copy of the read-only test. Two expressions
 * of one security classification is two places to edit and one of them easy
 * to forget, and a divergence would surface as the sandbox quietly skipping
 * an approval the boundary meant to ask for. The predicate is gone; the
 * catalog now asks the policy. These cases stay, pointed at the boundary, so
 * a future re-introduction of a local copy has to disagree with them first.
 */
describe("Code Mode defers the approval classification to the policy", () => {
  const cases: [string, Partial<McpTool>, boolean][] = [
    [
      "explicitly read-only with a declared output schema",
      {
        annotations: { readOnlyHint: true },
        outputSchema: { type: "object", properties: { result: { type: "string" } } },
      },
      true,
    ],
    [
      "explicitly read-only with no output schema",
      { annotations: { readOnlyHint: true }, outputSchema: undefined },
      true,
    ],
    [
      "readOnlyHint explicitly false",
      { annotations: { readOnlyHint: false }, outputSchema: { type: "object", properties: {} } },
      false,
    ],
    [
      "readOnlyHint absent",
      { annotations: {}, outputSchema: { type: "object", properties: {} } },
      false,
    ],
    [
      "no annotations at all",
      { annotations: undefined, outputSchema: { type: "object", properties: {} } },
      false,
    ],
    [
      "read-only but also destructive",
      {
        annotations: { readOnlyHint: true, destructiveHint: true },
        outputSchema: { type: "object", properties: {} },
      },
      false,
    ],
  ];

  for (const [label, overrides, unattended] of cases) {
    it(`agrees with the policy for a tool that is ${label}`, () => {
      const tool = makeTool(overrides);
      expect(toCodeModeTool(tool).runsUnattended).toBe(unattended);
      // The catalog flag is the policy's answer, not a parallel opinion.
      expect(toCodeModeTool(tool).runsUnattended).toBe(isReadOnlyToolCall(tool));
    });
  }

  it("never treats an approval-gated tool as absent from the catalog", () => {
    // Requiring approval is not a reason to hide a tool. This is the
    // regression that made the sandbox able to see work it could not finish.
    const write = makeTool({ name: "write_thing", annotations: { readOnlyHint: false } });
    const entry = toCodeModeTool(write);
    expect(entry.runsUnattended).toBe(false);
    expect(entry.tool).toBe(write);
    expect(entry.outputSchema).toBeDefined();
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
