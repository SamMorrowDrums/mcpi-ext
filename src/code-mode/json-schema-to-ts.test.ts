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
