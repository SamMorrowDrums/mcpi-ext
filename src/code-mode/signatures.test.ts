import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { buildCatalogSnapshot } from "./catalog.js";
import { toCodeModeTool } from "./eligibility.js";
import { loadGithubFixture } from "./fixtures.js";
import { renderCompactSignature } from "./signatures.js";

function typeErrors(source: string): string[] {
  const filename = "generated-code-mode-type.ts";
  const options = { strict: true, noEmit: true, types: [] };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) =>
    name === filename
      ? ts.createSourceFile(name, source, languageVersion, true)
      : getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
  const program = ts.createProgram([filename], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

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
  it("keeps the real search_issues count on the returned DTO", () => {
    const searchIssues = loadGithubFixture().find((entry) => entry.name === "search_issues");
    expect(searchIssues).toBeDefined();
    if (!searchIssues) return;

    const signature = signatureFor(searchIssues);

    expect(signature).toContain("returns: Promise<{ total_count?: null | number;");
    expect(signature).toContain("incomplete_results?: null | boolean;");
    expect(signature).toContain("items: null | Record<string, unknown>[];");
    expect(signature).not.toContain("structuredContent?:");
  });

  it("types a declared schema as the direct return value", () => {
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
    expect(signature).toContain("returns: Promise<{ total_count: number;");
    expect(signature).not.toContain("structuredContent?:");
    expect(signature).toContain("isError results throw upstream_error");
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

  it("preserves nullability when an oversized nullable object is summarized", () => {
    const signature = signatureFor(
      tool({
        outputSchema: {
          type: ["object", "null"],
          properties: Object.fromEntries(
            Array.from({ length: 100 }, (_, index) => [
              `field_${String(index)}`,
              { type: "string" },
            ]),
          ),
        },
      }),
    );
    expect(signature).toContain("returns: Promise<Record<string, unknown> | null>");
  });

  it.each([false, true])(
    "describe accepts schema-valid DTOs with mixed additionalProperties and optional=%s",
    (optional) => {
      const signature = signatureFor(
        tool({
          outputSchema: {
            type: "object",
            properties: {
              name: { type: "string" },
              ...(optional ? { active: { type: "boolean" } } : {}),
            },
            required: ["name"],
            additionalProperties: { type: "integer" },
          },
        }),
      );
      const returnType = /^ {2}returns: (.+)$/m.exec(signature)?.[1];
      expect(returnType).toBeDefined();
      expect(signature).toContain("Record<string, number | string");
      if (optional) expect(signature).toContain("boolean | undefined");
      expect(
        typeErrors(`
        type DTO = Awaited<${returnType}>;
        const value: DTO = { name: "example", extra: 1 };
        ${optional ? 'const optionalValue: DTO = { name: "example", active: true, extra: 1 };' : ""}
      `),
      ).toEqual([]);
      expect(
        typeErrors(`
        type DTO = Awaited<${returnType}>;
        const invalid: DTO = { name: 123, extra: 1 };
      `),
      ).not.toEqual([]);
    },
  );
});
