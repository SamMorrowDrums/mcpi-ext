import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { buildCatalogSnapshot } from "./catalog.js";
import { toCodeModeTool } from "./eligibility.js";
import { loadGithubFixture } from "./fixtures.js";
import { renderCompactSignature } from "./signatures.js";

function signatureFor(tool: McpTool): string {
  const snapshot = buildCatalogSnapshot([toCodeModeTool(tool)]);
  return renderCompactSignature(snapshot.entries[0]);
}

function tool(overrides: Partial<McpTool> = {}): McpTool {
  return {
    name: "search_issues",
    serverName: "github",
    description: "Search issues and return a count plus matching items",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

describe("compact Code Mode result signatures", () => {
  it("keeps the real search_issues count on structuredContent", () => {
    const searchIssues = loadGithubFixture().find((entry) => entry.name === "search_issues");
    expect(searchIssues).toBeDefined();
    if (!searchIssues) return;

    const signature = signatureFor(searchIssues);

    expect(signature).toContain("structuredContent?: { total_count?: null | number;");
    expect(signature).toContain("incomplete_results?: null | boolean;");
    expect(signature).toContain("items: null | Record<string, unknown>[];");
    expect(signature).not.toContain("returns: Promise<{ total_count:");
  });

  it("types a declared schema inside the raw CallToolResult envelope", () => {
    const signature = signatureFor(
      tool({
        outputSchema: {
          type: "object",
          properties: {
            total_count: { type: "number" },
            incomplete_results: { type: "boolean" },
            items: {
              type: "array",
              items: {
                type: "object",
                properties: { number: { type: "number" }, title: { type: "string" } },
                required: ["number", "title"],
              },
            },
          },
          required: ["total_count", "incomplete_results", "items"],
        },
      }),
    );

    expect(signature).toContain("returns: Promise<{");
    expect(signature).toContain("content: Array<{ type: string } & Record<string, unknown>>");
    expect(signature).toContain("structuredContent?: { total_count: number;");
    expect(signature).toContain("isError?: boolean");
    expect(signature).toContain("_meta?: Record<string, unknown>");
    expect(signature).toContain("schemaHash (not snapshotId):");
    expect(signature).not.toContain("output (declared):");
  });

  it("types synthesized output as optional unknown structured content and teaches inspection", () => {
    const signature = signatureFor(tool());

    expect(signature).toContain("structuredContent?: unknown");
    expect(signature).toContain("codemode.inspect(result)");
    expect(signature).toContain("codemode.inspect(result.structuredContent)");
  });

  it("keeps generated return-type source syntactically valid and bounded", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `field_${String(index)}`,
        { type: "string", description: `Field ${String(index)}` },
      ]),
    );
    const signature = signatureFor(
      tool({
        outputSchema: {
          type: "object",
          properties,
          required: Object.keys(properties),
        },
      }),
    );
    const returnType = /^ {2}returns: (.+)$/m.exec(signature)?.[1];

    expect(returnType).toBeDefined();
    if (!returnType) return;

    expect(Buffer.byteLength(returnType, "utf8")).toBeLessThanOrEqual(600);
    const transpiled = ts.transpileModule(`type GeneratedResult = ${returnType};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    const syntaxErrors = (transpiled.diagnostics ?? []).filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    expect(syntaxErrors).toEqual([]);
  });
});
