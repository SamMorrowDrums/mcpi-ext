import { jsonSchemaToTypeString } from "./json-schema-to-ts.js";
import type { CatalogEntry } from "./catalog.js";

type JsonSchema = Record<string, unknown>;

/** Honest description of what a caller may assume about a tool's result. */
export const UNKNOWN_OUTPUT_NOTE =
  "result note: this server declared no output schema, so structuredContent is optional unknown. Use codemode.inspect(result), then codemode.inspect(result.structuredContent) when it is present.";

const SEARCH_DESCRIPTION_CHARS = 120;
const DESCRIBE_DESCRIPTION_CHARS = 400;
const PARAM_DESCRIPTION_CHARS = 160;
const PARAM_TYPE_CHARS = 200;
const STRUCTURED_CONTENT_TYPE_CHARS = 360;
const CONTENT_BLOCK_TYPE = "Array<{ type: string } & Record<string, unknown>>";

/**
 * One compact line naming a tool's parameters without their schemas.
 *
 * Search hits use this: enough to tell two similar tools apart, not enough to
 * call one blind, which is deliberate — describe is the step that licenses a call.
 */
export function renderParamNames(entry: CatalogEntry): string {
  const { properties, required } = readProperties(entry.tool.inputSchema as JsonSchema | undefined);
  const names = Object.keys(properties);
  if (names.length === 0) return "()";
  return `(${names.map((name) => (required.has(name) ? name : `${name}?`)).join(", ")})`;
}

/** A compact search hit. Never carries full schemas. */
export function renderSearchRow(entry: CatalogEntry): string {
  const description = clamp(entry.tool.description, SEARCH_DESCRIPTION_CHARS);
  return [
    `${entry.ref} [${entry.effect}] ${renderParamNames(entry)}`,
    description ? `  ${description}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/**
 * A full compact signature for one tool.
 *
 * Only produced for refs the caller explicitly asked about. Large nested
 * schemas are summarized at valid type boundaries so one tool cannot consume
 * the whole discovery response budget.
 */
export function renderCompactSignature(entry: CatalogEntry): string {
  const lines: string[] = [];
  lines.push(`${entry.ref} [${entry.effect}]`);
  lines.push(`  namespace: ${entry.namespace}`);
  lines.push(`  schemaHash (not snapshotId): ${entry.schemaHash.slice(0, 12)}`);

  const description = clamp(entry.tool.description, DESCRIBE_DESCRIPTION_CHARS);
  if (description) lines.push(`  ${description}`);

  const inputSchema = entry.tool.inputSchema as JsonSchema | undefined;
  const { properties, required } = readProperties(inputSchema);
  const definitions = readDefinitions(inputSchema);
  const names = Object.keys(properties);

  if (names.length === 0) {
    lines.push("  input: {}");
  } else {
    lines.push("  input:");
    for (const name of names) {
      const schema = properties[name] as JsonSchema;
      const optional = required.has(name) ? "" : "?";
      lines.push(
        `    ${safePropertyName(name)}${optional}: ${boundedSchemaType(
          schema,
          definitions,
          PARAM_TYPE_CHARS,
        )}`,
      );
      const paramDescription = clamp(
        typeof schema.description === "string" ? schema.description : undefined,
        PARAM_DESCRIPTION_CHARS,
      );
      if (paramDescription) lines.push(`      ${paramDescription}`);
    }
  }

  lines.push(`  ${renderOutputNote(entry)}`);
  lines.push(`  ${renderResultGuard(entry)}`);
  return lines.join("\n");
}

/**
 * Render the asynchronous result as the raw MCP envelope Code Mode returns.
 *
 * The declared output schema types `structuredContent`, not the top level.
 * Unknown and future envelope fields remain representable through the index
 * signature, while `content`, `isError`, and `_meta` stay visible.
 */
export function renderOutputNote(entry: CatalogEntry): string {
  const structuredContentType =
    entry.entry.outputSchemaProvenance === "declared" && entry.entry.outputSchema
      ? boundedSchemaType(
          entry.entry.outputSchema as JsonSchema,
          readDefinitions(entry.entry.outputSchema as JsonSchema),
          STRUCTURED_CONTENT_TYPE_CHARS,
        )
      : "unknown";
  return (
    `returns: Promise<{ content: ${CONTENT_BLOCK_TYPE}; ` +
    `structuredContent?: ${structuredContentType}; isError?: boolean; ` +
    `_meta?: Record<string, unknown>; [field: string]: unknown }>`
  );
}

function renderResultGuard(entry: CatalogEntry): string {
  if (entry.entry.outputSchemaProvenance !== "declared" || !entry.entry.outputSchema) {
    return UNKNOWN_OUTPUT_NOTE;
  }
  return (
    "result guard: successful non-error structuredContent is MCP-client validated, but an " +
    "isError envelope may omit it. Check result.isError || " +
    "result.structuredContent === undefined before reading declared fields."
  );
}

function readProperties(schema: JsonSchema | undefined): {
  properties: Record<string, unknown>;
  required: Set<string>;
} {
  const properties =
    schema && typeof schema.properties === "object" && schema.properties !== null
      ? (schema.properties as Record<string, unknown>)
      : {};
  const required = new Set<string>(
    schema && Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  return { properties, required };
}

function readDefinitions(schema: JsonSchema | undefined): Record<string, JsonSchema> | undefined {
  if (!schema) return undefined;
  return (schema.$defs ?? schema.definitions) as Record<string, JsonSchema> | undefined;
}

/**
 * Render a schema as a syntactically complete compact type.
 *
 * Large nested definitions are summarized rather than sliced mid-token. The
 * old character truncation could emit invalid source such as an unterminated
 * object type; a bounded approximation is both valid and more honest.
 */
function boundedSchemaType(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema> | undefined,
  maxChars: number,
): string {
  const complete = collapseType(jsonSchemaToTypeString(schema, definitions));
  if (complete.length <= maxChars) return complete;

  const { properties, required } = readProperties(schema);
  if (Object.keys(properties).length === 0) return coarseSchemaType(schema, definitions);

  const pieces: string[] = [];
  let omitted = 0;
  for (const [name, value] of Object.entries(properties)) {
    const propertySchema = value as JsonSchema;
    const completeProperty = collapseType(jsonSchemaToTypeString(propertySchema, definitions));
    const propertyType =
      completeProperty.length <= 100
        ? completeProperty
        : coarseSchemaType(propertySchema, definitions);
    const piece = `${safePropertyName(name)}${required.has(name) ? "" : "?"}: ${propertyType};`;
    const candidate = `{ ${[...pieces, piece].join(" ")} }`;
    if (candidate.length > maxChars - 35) {
      omitted += 1;
      continue;
    }
    pieces.push(piece);
  }

  if (omitted > 0) {
    pieces.push(`[field: string]: unknown; /* ${String(omitted)} declared field(s) omitted */`);
  }
  const summarized = `{ ${pieces.join(" ")} }`;
  return summarized.length <= maxChars
    ? summarized
    : "unknown /* declared schema exceeds compact signature budget */";
}

function coarseSchemaType(
  schema: JsonSchema,
  definitions: Record<string, JsonSchema> | undefined,
  depth = 0,
): string {
  if (depth > 4) return "unknown";
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.replace(/^#\/(definitions|components\/schemas|\$defs)\//, "");
    const resolved = definitions?.[name];
    return resolved ? coarseSchemaType(resolved, definitions, depth + 1) : "unknown";
  }

  const type = schema.type;
  if (Array.isArray(type)) {
    return [
      ...new Set(
        type.map((variant) =>
          typeof variant === "string"
            ? coarseSchemaType({ ...schema, type: variant }, definitions, depth + 1)
            : "unknown",
        ),
      ),
    ].join(" | ");
  }

  switch (type) {
    case "array": {
      const items = schema.items;
      if (!items || Array.isArray(items) || typeof items !== "object") return "unknown[]";
      return `${coarseSchemaType(items as JsonSchema, definitions, depth + 1)}[]`;
    }
    case "object":
      return "Record<string, unknown>";
    case "integer":
    case "number":
      return "number";
    case "string":
    case "boolean":
    case "null":
      return type;
    default:
      return schema.properties ? "Record<string, unknown>" : "unknown";
  }
}

/** Flatten a multi-line generated type onto one line without truncating syntax. */
function collapseType(type: string): string {
  return type
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function safePropertyName(name: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name) ? name : JSON.stringify(name);
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
