import type { McpTool } from "../mcp/index.js";
import { getCodeModeDiagnostics, toCodeModeTool, type CodeModeTool } from "./eligibility.js";

type JsonSchema = Record<string, unknown>;

/**
 * Convert a JSON Schema to a TypeScript type string.
 *
 * Handles objects, arrays, primitives, enums, anyOf/oneOf/allOf, $ref,
 * and circular references (depth guard at 20).
 */
export function jsonSchemaToTypeString(
  schema: JsonSchema,
  definitions?: Record<string, JsonSchema>,
  depth = 0,
  seen = new Set<JsonSchema>(),
): string {
  if (depth > 20) return "unknown";
  if (seen.has(schema)) return "unknown";
  seen.add(schema);

  // Handle $ref
  if (typeof schema.$ref === "string") {
    const refPath = schema.$ref;
    const refName = refPath.replace(/^#\/(definitions|components\/schemas|\\$defs)\//, "");
    const resolved = definitions?.[refName];
    if (resolved) {
      return jsonSchemaToTypeString(resolved, definitions, depth + 1, seen);
    }
    return "unknown";
  }

  // Handle enum
  if (Array.isArray(schema.enum)) {
    return schema.enum.map((v: unknown) => JSON.stringify(v)).join(" | ");
  }

  // Handle const
  if ("const" in schema) {
    return JSON.stringify(schema.const);
  }

  // Handle anyOf / oneOf
  const unionKey = schema.anyOf ? "anyOf" : schema.oneOf ? "oneOf" : null;
  if (unionKey && Array.isArray(schema[unionKey])) {
    const variants = (schema[unionKey] as JsonSchema[]).map((s) =>
      jsonSchemaToTypeString(s, definitions, depth + 1, seen),
    );
    return variants.join(" | ");
  }

  // Handle allOf
  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as JsonSchema[]).map((s) =>
      jsonSchemaToTypeString(s, definitions, depth + 1, seen),
    );
    return parts.join(" & ");
  }

  const type = schema.type as string | string[] | undefined;

  // Handle type arrays (e.g. ["string", "null"])
  if (Array.isArray(type)) {
    const types = type.map((t: string) => primitiveToTs(t));
    return types.join(" | ");
  }

  switch (type) {
    case "object":
      return objectToTs(schema, definitions, depth, seen);
    case "array":
      return arrayToTs(schema, definitions, depth, seen);
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return primitiveToTs(type);
    default:
      // No type specified — try to infer from properties
      if (schema.properties) {
        return objectToTs(schema, definitions, depth, seen);
      }
      return "unknown";
  }
}

function primitiveToTs(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function objectToTs(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema> | undefined,
  depth: number,
  seen: Set<JsonSchema>,
): string {
  const properties = schema.properties as Record<string, JsonSchema> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return "Record<string, unknown>";
  }

  const required = new Set<string>(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const lines: string[] = [];

  for (const [key, propSchema] of Object.entries(properties)) {
    const desc = propSchema.description as string | undefined;
    if (desc) {
      lines.push(`  /** ${desc} */`);
    }
    const optional = required.has(key) ? "" : "?";
    const typeStr = jsonSchemaToTypeString(propSchema, definitions, depth + 1, seen);
    lines.push(`  ${safeName(key)}${optional}: ${typeStr};`);
  }

  return `{\n${lines.join("\n")}\n}`;
}

function arrayToTs(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema> | undefined,
  depth: number,
  seen: Set<JsonSchema>,
): string {
  const items = schema.items as JsonSchema | undefined;
  if (!items) return "unknown[]";

  // Tuple form
  if (Array.isArray(items)) {
    const tupleTypes = items.map((s: JsonSchema) =>
      jsonSchemaToTypeString(s, definitions, depth + 1, seen),
    );
    return `[${tupleTypes.join(", ")}]`;
  }

  const itemType = jsonSchemaToTypeString(items, definitions, depth + 1, seen);
  return `${itemType}[]`;
}

/** Ensure property name is a valid JS identifier, quote otherwise. */
function safeName(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

/** Sanitize a tool name to be a valid JS identifier. */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_$]/g, "_");
}

/**
 * Generate TypeScript type declarations for a set of MCP tools.
 *
 * Produces a `declare const codemode: { ... }` block with type-safe
 * method signatures the model can use when writing code.
 */
export function generateTypeHints(tools: readonly (McpTool | CodeModeTool)[]): string {
  const codeModeTools = tools.map(normalizeCodeModeTool);
  const diagnostics = getCodeModeDiagnostics(codeModeTools);
  const methods: string[] = [];

  for (const codeModeTool of codeModeTools) {
    const tool = codeModeTool.tool;
    const safeName = sanitizeToolName(tool.name);
    const inputSchema = tool.inputSchema as JsonSchema;
    const outputSchema = codeModeTool.outputSchema as JsonSchema | undefined;
    const definitions = (inputSchema.$defs ??
      inputSchema.definitions ??
      outputSchema?.$defs ??
      outputSchema?.definitions) as Record<string, JsonSchema> | undefined;

    // Build input type
    const inputType = generateInputType(safeName, inputSchema, definitions);

    // Build output type
    const outputType = outputSchema ? jsonSchemaToTypeString(outputSchema, definitions) : "unknown";

    // Build JSDoc
    const jsdoc = buildJsDoc(codeModeTool, inputSchema);

    methods.push(`${jsdoc}  ${safeName}: (input: ${inputType}) => Promise<${outputType}>;`);
  }

  const toolListType =
    codeModeTools.length > 0
      ? codeModeTools.map((entry) => `"${escapeStr(entry.tool.name)}"`).join(" | ")
      : "never";

  return [
    "// Code mode type hints — auto-generated from MCP tool schemas",
    "// Available tools are accessed via the `codemode` namespace",
    `// MCP catalog: ${diagnostics.totalTools} tool(s); ${diagnostics.callableTools} callable, ${diagnostics.refusedTools} dispatch-refused`,
    `// Output schemas: ${diagnostics.declaredOutputSchemas} declared, ${diagnostics.synthesizedOutputSchemas} synthesized, ${diagnostics.unavailableOutputSchemas} unavailable`,
    "",
    `declare const codemode: {`,
    `  /** List all available code mode tool names. */`,
    `  listTools: () => Promise<(${toolListType})[]>;`,
    `  /** Get full type information for specific tools. */`,
    `  describeTools: (names: string[]) => Promise<string>;`,
    ...methods.map((m) => m),
    `};`,
  ].join("\n");
}

function generateInputType(
  _toolSafeName: string,
  inputSchema: JsonSchema,
  definitions: Record<string, JsonSchema> | undefined,
): string {
  const properties = inputSchema.properties as Record<string, JsonSchema> | undefined;
  if (!properties || Object.keys(properties).length === 0) {
    return "Record<string, never>";
  }

  // Always inline the type — avoids emitting unreferenced named type aliases
  const typeStr = jsonSchemaToTypeString(inputSchema, definitions);
  return typeStr;
}

function buildJsDoc(codeModeTool: CodeModeTool, inputSchema: JsonSchema): string {
  const tool = codeModeTool.tool;
  const lines: string[] = ["  /**"];

  if (tool.description) {
    lines.push(`   * ${tool.description}`);
  }

  if (codeModeTool.callable) {
    lines.push("   * Code Mode dispatch: callable (explicitly read-only and non-destructive).");
  } else {
    lines.push("   * Code Mode dispatch: refused. Use a permission-aware non-Code-Mode path.");
  }
  lines.push(`   * Output schema provenance: ${codeModeTool.outputSchemaProvenance}.`);

  const properties = inputSchema.properties as Record<string, JsonSchema> | undefined;
  if (properties) {
    for (const [key, propSchema] of Object.entries(properties)) {
      const desc = propSchema.description as string | undefined;
      if (desc) {
        lines.push(`   * @param input.${key} - ${desc}`);
      }
    }
  }

  lines.push("   */");
  return lines.join("\n") + "\n";
}

function escapeStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, " ");
}

function normalizeCodeModeTool(tool: McpTool | CodeModeTool): CodeModeTool {
  return "tool" in tool && "outputSchemaProvenance" in tool ? tool : toCodeModeTool(tool);
}
