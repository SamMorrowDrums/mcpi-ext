import { jsonSchemaToTypeString } from "./type-hints.js";
import type { CatalogEntry } from "./catalog.js";

type JsonSchema = Record<string, unknown>;

/** Honest description of what a caller may assume about a tool's result. */
export const UNKNOWN_OUTPUT_NOTE =
  "output: unknown — this server declared no output schema. Call it, then use codemode.inspect(result) to learn the shape.";

const SEARCH_DESCRIPTION_CHARS = 120;
const DESCRIBE_DESCRIPTION_CHARS = 400;
const PARAM_DESCRIPTION_CHARS = 160;

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
 * Measured at roughly 46% of the raw JSON schema for the same tool, and it is
 * only ever produced for refs the caller explicitly asked about.
 */
export function renderCompactSignature(entry: CatalogEntry): string {
  const lines: string[] = [];
  lines.push(`${entry.ref} [${entry.effect}]`);
  lines.push(`  namespace: ${entry.namespace}  schemaHash: ${entry.schemaHash.slice(0, 12)}`);

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
      const type = jsonSchemaToTypeString(schema, definitions);
      lines.push(`    ${name}${optional}: ${collapseType(type)}`);
      const paramDescription = clamp(
        typeof schema.description === "string" ? schema.description : undefined,
        PARAM_DESCRIPTION_CHARS,
      );
      if (paramDescription) lines.push(`      ${paramDescription}`);
    }
  }

  lines.push(`  ${renderOutputNote(entry)}`);
  return lines.join("\n");
}

/**
 * Say what is actually known about the output.
 *
 * A declared schema becomes a real type. An absent one is reported as unknown,
 * never as `Record<string, unknown>` — claiming an object shape a server never
 * promised is how a model ends up indexing into undefined with confidence.
 */
export function renderOutputNote(entry: CatalogEntry): string {
  if (entry.entry.outputSchemaProvenance !== "declared" || !entry.entry.outputSchema) {
    return UNKNOWN_OUTPUT_NOTE;
  }
  const schema = entry.entry.outputSchema as JsonSchema;
  const type = jsonSchemaToTypeString(schema, readDefinitions(schema));
  return `output (declared): ${collapseType(type)}`;
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

/** Flatten a multi-line generated type onto one line, with a length guard. */
function collapseType(type: string): string {
  const collapsed = type
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return collapsed.length <= 200 ? collapsed : `${collapsed.slice(0, 199)}…`;
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}
