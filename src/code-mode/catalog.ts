import { createHash } from "node:crypto";
import type { McpTool } from "../mcp/index.js";
import type { CodeModeTool } from "./eligibility.js";
import {
  deriveNamespaces,
  namespaceForTool,
  serverOnlyNamespaceId,
  type DeriveNamespacesOptions,
  type NamespaceSummary,
} from "./namespaces.js";

/** Effect class of a single tool, derived from its declared annotations. */
export type ToolEffect = "read" | "write" | "unknown";

/**
 * One tool in the Code Mode catalog, under its canonical identity.
 *
 * `ref` is the authority form and is always unique. `alias` is a convenience
 * that only exists when it can be offered honestly.
 */
export interface CatalogEntry {
  readonly serverName: string;
  readonly namespace: string;
  readonly toolName: string;
  /** Canonical `server/tool` reference. Always unique, always resolvable. */
  readonly ref: string;
  /**
   * Flat sanitized identifier, present only when globally unique.
   *
   * Absent when two servers publish the same tool name, because a first-match
   * alias would silently dispatch to whichever server happened to connect
   * first — a wrong answer that looks like a right one.
   */
  readonly alias?: string;
  /** SHA-256 over the declared input and output schema. */
  readonly schemaHash: string;
  readonly effect: ToolEffect;
  readonly tool: McpTool;
  readonly entry: CodeModeTool;
}

/**
 * An immutable view of the catalog at a point in time.
 *
 * `snapshotId` changes if and only if the catalog's substance changes, so a
 * script that describes a tool and then calls it can prove it called the thing
 * it described.
 */
export interface CatalogSnapshot {
  readonly snapshotId: string;
  readonly servers: readonly string[];
  readonly namespaces: readonly NamespaceSummary[];
  readonly entries: readonly CatalogEntry[];
  readonly byRef: ReadonlyMap<string, CatalogEntry>;
  readonly byAlias: ReadonlyMap<string, CatalogEntry>;
  /** Tool names published by more than one server. */
  readonly ambiguous: ReadonlyMap<string, readonly CatalogEntry[]>;
}

export type BuildCatalogOptions = DeriveNamespacesOptions;

/** Build a snapshot from the client-internal Code Mode catalog. */
export function buildCatalogSnapshot(
  tools: readonly CodeModeTool[],
  options: BuildCatalogOptions = {},
): CatalogSnapshot {
  const mcpTools = tools.map((entry) => entry.tool);
  const namespaces = deriveNamespaces(mcpTools, options);

  const byName = new Map<string, CodeModeTool[]>();
  for (const entry of tools) {
    const bucket = byName.get(entry.tool.name);
    if (bucket) bucket.push(entry);
    else byName.set(entry.tool.name, [entry]);
  }

  const entries: CatalogEntry[] = tools
    .map((entry) => {
      const tool = entry.tool;
      const unique = (byName.get(tool.name)?.length ?? 0) === 1;
      const namespace =
        namespaceForTool(tool, namespaces) || serverOnlyNamespaceId(tool.serverName);
      return {
        serverName: tool.serverName,
        namespace,
        toolName: tool.name,
        ref: canonicalRef(tool.serverName, tool.name),
        ...(unique ? { alias: sanitizeIdentifier(tool.name) } : {}),
        schemaHash: hashSchemas(entry),
        effect: toolEffect(tool),
        tool,
        entry,
      } satisfies CatalogEntry;
    })
    .sort((left, right) => compareStrings(left.ref, right.ref));

  const byRef = new Map(entries.map((entry) => [entry.ref, entry]));
  const byAlias = new Map<string, CatalogEntry>();
  const aliasCollisions = new Set<string>();
  for (const entry of entries) {
    if (!entry.alias) continue;
    // Sanitizing can collide even when raw names do not (`a.b` and `a-b`).
    if (byAlias.has(entry.alias)) {
      aliasCollisions.add(entry.alias);
      continue;
    }
    byAlias.set(entry.alias, entry);
  }
  for (const alias of aliasCollisions) byAlias.delete(alias);

  const ambiguous = new Map<string, CatalogEntry[]>();
  for (const [name, bucket] of byName) {
    if (bucket.length < 2) continue;
    ambiguous.set(
      name,
      entries.filter((entry) => entry.toolName === name),
    );
  }

  return {
    snapshotId: computeSnapshotId(entries),
    servers: [...new Set(entries.map((entry) => entry.serverName))].sort(compareStrings),
    namespaces,
    entries,
    byRef,
    byAlias,
    ambiguous,
  };
}

/** Canonical `server/tool` reference. */
export function canonicalRef(serverName: string, toolName: string): string {
  return `${serverName}/${toolName}`;
}

export interface ResolveOk {
  readonly ok: true;
  readonly entry: CatalogEntry;
}

export interface ResolveError {
  readonly ok: false;
  readonly error: "unknown_tool" | "ambiguous_tool";
  readonly message: string;
  readonly candidates?: readonly string[];
}

export type ResolveResult = ResolveOk | ResolveError;

/**
 * Resolve a reference to exactly one catalog entry.
 *
 * Accepts `server/tool`, `server/namespace/tool`, or a bare tool name. A bare
 * name resolves only when it is globally unique; otherwise this refuses and
 * names the qualified alternatives, because guessing between two servers is
 * how you post a comment on the wrong repository.
 */
export function resolveTool(snapshot: CatalogSnapshot, reference: string): ResolveResult {
  const trimmed = reference.trim();
  if (!trimmed) {
    return { ok: false, error: "unknown_tool", message: "Tool reference is empty." };
  }

  const direct = snapshot.byRef.get(trimmed);
  if (direct) return { ok: true, entry: direct };

  const parts = trimmed.split("/");
  if (parts.length === 3) {
    const [serverName, namespace, toolName] = parts as [string, string, string];
    const entry = snapshot.byRef.get(canonicalRef(serverName, toolName));
    if (entry && entry.namespace === namespace) return { ok: true, entry };
    if (entry) {
      return {
        ok: false,
        error: "unknown_tool",
        message: `"${trimmed}" does not match: ${entry.toolName} is in namespace "${entry.namespace}".`,
        candidates: [entry.ref],
      };
    }
  }

  if (parts.length === 1) {
    const collisions = snapshot.ambiguous.get(trimmed);
    if (collisions) return ambiguityError(trimmed, collisions);

    const byName = snapshot.entries.filter((entry) => entry.toolName === trimmed);
    const only = byName[0];
    if (byName.length === 1 && only) return { ok: true, entry: only };

    const byAlias = snapshot.byAlias.get(trimmed);
    if (byAlias) return { ok: true, entry: byAlias };

    const aliasCollisions = snapshot.entries.filter(
      (entry) => sanitizeIdentifier(entry.toolName) === trimmed,
    );
    if (aliasCollisions.length > 1) return ambiguityError(trimmed, aliasCollisions);
  }

  return {
    ok: false,
    error: "unknown_tool",
    message: `No tool matches "${trimmed}". Use code_search to find the canonical server/tool reference.`,
  };
}

function ambiguityError(name: string, candidates: readonly CatalogEntry[]): ResolveError {
  const refs = candidates.map((entry) => entry.ref).sort(compareStrings);
  return {
    ok: false,
    error: "ambiguous_tool",
    message:
      `"${name}" is published by ${refs.length} servers. ` +
      `Call it by canonical reference instead: ${refs.join(", ")}.`,
    candidates: refs,
  };
}

/** Derive a tool's effect class from its declared annotations. */
export function toolEffect(tool: McpTool): ToolEffect {
  const annotations = tool.annotations;
  if (annotations?.readOnlyHint === true && annotations.destructiveHint !== true) return "read";
  if (annotations?.readOnlyHint === false || annotations?.destructiveHint === true) return "write";
  return "unknown";
}

/** Sanitize a tool name into a valid JS identifier. */
export function sanitizeIdentifier(name: string): string {
  const replaced = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
}

function hashSchemas(entry: CodeModeTool): string {
  return sha256(
    canonicalJson({
      input: entry.tool.inputSchema ?? null,
      output: entry.outputSchema ?? null,
      provenance: entry.outputSchemaProvenance,
    }),
  );
}

/**
 * Identify a catalog by its substance.
 *
 * Built from canonical identity plus schema hash only, so reordering servers or
 * reconnecting does not invent a new snapshot, but a changed schema does.
 */
function computeSnapshotId(entries: readonly CatalogEntry[]): string {
  const lines = entries
    .map(
      (entry) => `${entry.serverName}\t${entry.namespace}\t${entry.toolName}\t${entry.schemaHash}`,
    )
    .sort(compareStrings);
  return sha256(lines.join("\n"));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Stable JSON with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort(compareStrings)) {
      sorted[key] = sortKeys(record[key]);
    }
    return sorted;
  }
  return value;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
