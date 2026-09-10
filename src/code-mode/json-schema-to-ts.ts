// Renders a JSON Schema as a TypeScript type string.
//
// This is a formatter, not a disclosure mechanism. It backs the compact
// signatures returned by an explicit `describe`; nothing here is rendered
// into the system prompt. The eager `generateTypeHints` catalog that used
// to do that was removed with the pinned namespace prompt.

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
    const types = type.map((variant: string) =>
      jsonSchemaToTypeString({ ...schema, type: variant }, definitions, depth + 1, new Set(seen)),
    );
    return [...new Set(types)].join(" | ");
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
