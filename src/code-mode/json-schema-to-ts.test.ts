import { describe, expect, it } from "vitest";
import { jsonSchemaToTypeString } from "./json-schema-to-ts.js";

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

  it("preserves array structure inside nullable type arrays", () => {
    expect(
      jsonSchemaToTypeString({
        type: ["null", "array"],
        items: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
      }),
    ).toBe("null | {\n  id: number;\n}[]");
  });

  it("preserves the harness's nullable issue array and user object reproductions", () => {
    expect(
      jsonSchemaToTypeString({
        type: ["null", "array"],
        items: {
          type: "object",
          properties: { number: { type: "integer" } },
          required: ["number"],
        },
      }),
    ).toBe("null | {\n  number: number;\n}[]");
    expect(
      jsonSchemaToTypeString({
        type: ["null", "object"],
        properties: { login: { type: "string" } },
        required: ["login"],
      }),
    ).toBe("null | {\n  login: string;\n}");
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

  it("renders a github-mcp-server style issue DTO with $defs and nullable collections", () => {
    const result = jsonSchemaToTypeString({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        issues: { type: ["array", "null"], items: { $ref: "#/$defs/Issue" } },
        total_count: { type: "integer" },
      },
      required: ["issues", "total_count"],
      additionalProperties: false,
      $defs: {
        Issue: {
          type: "object",
          properties: {
            number: { type: "integer" },
            state: { type: "string", enum: ["open", "closed"] },
            user: {
              type: ["object", "null"],
              properties: { login: { type: "string" }, id: { type: "integer" } },
              required: ["login", "id"],
            },
            labels: { type: ["array", "null"], items: { type: "string" } },
            assignees: { type: ["array", "null"], items: { $ref: "#/$defs/User" } },
            closed_by: { $ref: "#/$defs/User" },
          },
          required: ["number", "state", "user", "labels"],
        },
        User: {
          type: "object",
          properties: { login: { type: "string" } },
          required: ["login"],
        },
      },
    });
    expect(result).toContain('state: "open" | "closed";');
    expect(result).toContain("user: {\n  login: string;\n  id: number;\n} | null;");
    expect(result).toContain("labels: string[] | null;");
    expect(result).toContain("assignees?: {\n  login: string;\n}[] | null;");
    expect(result).toContain("closed_by?: {\n  login: string;\n};");
    expect(result).toContain("total_count: number;");
    expect(result).not.toContain("unknown");
  });

  it.each(["anyOf", "oneOf"])("preserves %s nullable objects and arrays", (key) => {
    expect(
      jsonSchemaToTypeString({
        [key]: [{ type: "array", items: { type: "string" } }, { type: "null" }],
      }),
    ).toBe("string[] | null");
    expect(
      jsonSchemaToTypeString({
        [key]: [
          { type: "object", properties: { login: { type: "string" } }, required: ["login"] },
          { type: "null" },
        ],
      }),
    ).toBe("{\n  login: string;\n} | null");
  });

  it("parenthesizes unions used as array elements", () => {
    expect(
      jsonSchemaToTypeString({
        type: "array",
        items: { anyOf: [{ type: "string" }, { type: "null" }] },
      }),
    ).toBe("(string | null)[]");
  });

  it("renders additionalProperties maps and closed empty objects", () => {
    expect(
      jsonSchemaToTypeString({ type: "object", additionalProperties: { type: "integer" } }),
    ).toBe("Record<string, number>");
    expect(jsonSchemaToTypeString({ type: "object", additionalProperties: false })).toBe(
      "Record<string, never>",
    );
    expect(
      jsonSchemaToTypeString({
        type: "object",
        properties: { count: { type: "integer" } },
        required: ["count"],
        additionalProperties: { type: "integer" },
      }),
    ).toBe("({\n  count: number;\n} & Record<string, number>)");
    expect(
      jsonSchemaToTypeString({
        type: "object",
        properties: { login: { type: "string" } },
        additionalProperties: true,
      }),
    ).toContain("Record<string, unknown>");
  });

  it("treats repeated schema objects as siblings, not circular references", () => {
    const user = { type: "object", properties: { login: { type: "string" } }, required: ["login"] };
    const result = jsonSchemaToTypeString({
      type: "object",
      properties: {
        author: user,
        assignees: { type: ["null", "array"], items: user },
      },
    });
    expect(result).toContain("assignees?: null | {\n  login: string;\n}[];");
    expect(result).not.toContain("unknown");
  });

  it("widens additionalProperties to include declared keys and optional undefined", () => {
    expect(
      jsonSchemaToTypeString({
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: { type: "integer" },
      }),
    ).toBe("({\n  name: string;\n} & Record<string, number | string>)");
    expect(
      jsonSchemaToTypeString({
        type: "object",
        properties: { name: { type: "string" }, active: { type: "boolean" } },
        required: ["name"],
        additionalProperties: { type: "integer" },
      }),
    ).toBe(
      "({\n  name: string;\n  active?: boolean;\n} & Record<string, number | string | boolean | undefined>)",
    );
    expect(
      jsonSchemaToTypeString({
        type: "object",
        properties: { name: {} },
        additionalProperties: { type: "integer" },
      }),
    ).toContain("Record<string, unknown>");
  });

  it("guards recursive $defs and decodes JSON Pointer definition names", () => {
    expect(
      jsonSchemaToTypeString({
        $ref: "#/$defs/User~1Account",
        $defs: { "User/Account": { type: "string" } },
      }),
    ).toBe("string");
    expect(
      jsonSchemaToTypeString({
        $ref: "#/$defs/Node",
        $defs: {
          Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } },
        },
      }),
    ).toContain("next?: unknown;");
  });
});
