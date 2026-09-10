import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { generateTypeHints, jsonSchemaToTypeString, sanitizeToolName } from "./type-hints.js";

describe("jsonSchemaToTypeString", () => {
  it("converts string type", () => {
    expect(jsonSchemaToTypeString({ type: "string" })).toBe("string");
  });

  it("converts number type", () => {
    expect(jsonSchemaToTypeString({ type: "number" })).toBe("number");
  });

  it("converts integer type", () => {
    expect(jsonSchemaToTypeString({ type: "integer" })).toBe("number");
  });

  it("converts boolean type", () => {
    expect(jsonSchemaToTypeString({ type: "boolean" })).toBe("boolean");
  });

  it("converts null type", () => {
    expect(jsonSchemaToTypeString({ type: "null" })).toBe("null");
  });

  it("converts type array", () => {
    expect(jsonSchemaToTypeString({ type: ["string", "null"] })).toBe("string | null");
  });

  it("converts enum to union", () => {
    expect(jsonSchemaToTypeString({ enum: ["a", "b", "c"] })).toBe('"a" | "b" | "c"');
  });

  it("converts const", () => {
    expect(jsonSchemaToTypeString({ const: "fixed" })).toBe('"fixed"');
  });

  it("converts simple object", () => {
    const result = jsonSchemaToTypeString({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(result).toContain("name: string;");
    expect(result).toContain("age?: number;");
  });

  it("converts empty object to Record", () => {
    expect(jsonSchemaToTypeString({ type: "object" })).toBe("Record<string, unknown>");
  });

  it("converts array with items", () => {
    expect(jsonSchemaToTypeString({ type: "array", items: { type: "string" } })).toBe("string[]");
  });

  it("converts array without items", () => {
    expect(jsonSchemaToTypeString({ type: "array" })).toBe("unknown[]");
  });

  it("handles anyOf", () => {
    const result = jsonSchemaToTypeString({
      anyOf: [{ type: "string" }, { type: "number" }],
    });
    expect(result).toBe("string | number");
  });

  it("handles oneOf", () => {
    const result = jsonSchemaToTypeString({
      oneOf: [{ type: "boolean" }, { type: "null" }],
    });
    expect(result).toBe("boolean | null");
  });

  it("handles allOf", () => {
    const result = jsonSchemaToTypeString({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } }, required: ["b"] },
      ],
    });
    expect(result).toContain("a: string;");
    expect(result).toContain("b: number;");
    expect(result).toContain("&");
  });

  it("resolves $ref", () => {
    const result = jsonSchemaToTypeString(
      { $ref: "#/definitions/Foo" },
      { Foo: { type: "string" } },
    );
    expect(result).toBe("string");
  });

  it("handles unknown $ref gracefully", () => {
    expect(jsonSchemaToTypeString({ $ref: "#/definitions/Missing" }, {})).toBe("unknown");
  });

  it("guards against deep recursion", () => {
    // Create a deeply nested schema
    let schema: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 25; i++) {
      schema = { type: "object", properties: { nested: schema }, required: ["nested"] };
    }
    const result = jsonSchemaToTypeString(schema);
    expect(result).toContain("unknown"); // Should hit depth guard
  });

  it("includes description as JSDoc in object properties", () => {
    const result = jsonSchemaToTypeString({
      type: "object",
      properties: {
        query: { type: "string", description: "Search term" },
      },
      required: ["query"],
    });
    expect(result).toContain("/** Search term */");
  });
});

describe("sanitizeToolName", () => {
  it("replaces hyphens with underscores", () => {
    expect(sanitizeToolName("list-issues")).toBe("list_issues");
  });

  it("replaces dots with underscores", () => {
    expect(sanitizeToolName("github.search")).toBe("github_search");
  });

  it("keeps valid identifiers unchanged", () => {
    expect(sanitizeToolName("searchDocs")).toBe("searchDocs");
  });
});

describe("generateTypeHints", () => {
  it("emits built-ins and zero-count diagnostics for no tools", () => {
    const result = generateTypeHints([]);
    expect(result).toContain("MCP catalog: 0 tool(s); 0 run unattended, 0 pause for approval");
    expect(result).toContain("Output schemas: 0 declared, 0 synthesized, 0 unavailable");
    expect(result).toContain("listTools: () => Promise<(never)[]>");
  });

  it("generates declaration for a simple tool", () => {
    const tools: McpTool[] = [
      {
        name: "search_docs",
        description: "Search documentation",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term" },
          },
          required: ["query"],
        },
        outputSchema: {
          type: "object",
          properties: {
            results: { type: "array", items: { type: "string" } },
          },
          required: ["results"],
        },
        annotations: { readOnlyHint: true },
        serverName: "docs",
      },
    ];

    const result = generateTypeHints(tools);
    expect(result).toContain("declare const codemode");
    expect(result).toContain("search_docs:");
    expect(result).toContain("Promise<");
    expect(result).toContain("listTools");
    expect(result).toContain("describeTools");
    expect(result).toContain("Output schemas: 1 declared, 0 synthesized, 0 unavailable");
  });

  it("sanitizes tool names with special characters", () => {
    const tools: McpTool[] = [
      {
        name: "github.list-repos",
        description: "List repos",
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        serverName: "github",
      },
    ];

    const result = generateTypeHints(tools);
    expect(result).toContain("github_list_repos:");
  });

  it("includes unattended and approval-gated tools with schema provenance counts", () => {
    const tools: McpTool[] = [
      {
        name: "declared_read",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { value: { type: "number" } },
          required: ["value"],
        },
        annotations: { readOnlyHint: true },
        serverName: "fixture",
      },
      {
        name: "schema_less_read",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        serverName: "fixture",
      },
      {
        name: "write_records",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: true },
        serverName: "fixture",
      },
    ];

    const result = generateTypeHints(tools);

    expect(result).toContain("MCP catalog: 3 tool(s); 2 run unattended, 1 pause for approval");
    expect(result).toContain("Output schemas: 1 declared, 2 synthesized, 0 unavailable");
    expect(result).toContain("declared_read:");
    expect(result).toContain("schema_less_read:");
    expect(result).toContain("write_records:");
    expect(result).toContain("Output schema provenance: synthesized.");
    expect(result).toContain("Approval: pauses for user approval before the call reaches the server.");
  });
});
