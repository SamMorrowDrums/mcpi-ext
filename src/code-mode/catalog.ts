import { createHash } from "node:crypto";
import type { McpTool } from "../mcp/index.js";
import { approvalPosture, serializeApprovalPosture, type CodeModeTool } from "./eligibility.js";
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
 * The authority form of a tool's identity.
 *
 * Structured on purpose. `ref` is display and input syntax; it is built by
 * joining two attacker-influenced strings with `/`, so it cannot be the thing
 * a permission decision is made against. A server that names a tool `b/c`
 * produces the same `a/b/c` ref as server `a/b`'s tool `c`, and parsing that
 * back into a server and a tool is a guess.
 */
export interface ToolIdentity {
  readonly serverName: string;
  readonly toolName: string;
}

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
  /** SHA-256 over the declared input and output schema. The execution contract. */
  readonly schemaHash: string;
  /**
   * SHA-256 over everything about this tool the model can see.
   *
   * Broader than `schemaHash` on purpose. A server can leave every schema
   * untouched and rewrite a description into an instruction, and a digest over
   * the execution contract alone would call that the same tool. This covers
   * identity, title, description, both schemas, annotations, and declared
   * metadata, so any change to the model-visible bytes moves the snapshot and
   * invalidates approvals keyed to it.
   */
  readonly definitionDigest: string;
  /**
   * Serialized approval posture — effect class, unattended flag, and the
   * normalized reasons behind it.
   *
   * Carried explicitly rather than recomputed at each use, so that a change in
   * how a tool is approved is visible in the snapshot id itself and not only
   * inside an opaque digest.
   */
  readonly approval: string;
  readonly effect: ToolEffect;
  /** Operator-declared trust in the server that published this tool. */
  readonly trust: ServerTrust;
  readonly tool: McpTool;
  readonly entry: CodeModeTool;
}

/**
 * How far an operator has vetted a server.
 *
 * Defaults to `untrusted`, because a server nobody has reviewed is exactly
 * that, and a default that assumed otherwise would silently upgrade every
 * newly added server.
 */
export type ServerTrust = "untrusted" | "reviewed" | "managed";

export const DEFAULT_SERVER_TRUST: ServerTrust = "untrusted";

/** Operator-declared trust levels, keyed by server name. */
export type ServerTrustConfig = Readonly<Record<string, ServerTrust>>;

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
  /** Exact `(serverName, toolName)` lookup. The only unambiguous index. */
  readonly byIdentity: ReadonlyMap<string, CatalogEntry>;
  /** Tool names published by more than one server. */
  readonly ambiguous: ReadonlyMap<string, readonly CatalogEntry[]>;
  /** Refs that two distinct identities both render to, and so cannot resolve. */
  readonly collidingRefs: ReadonlySet<string>;
}

export interface BuildCatalogOptions extends DeriveNamespacesOptions {
  readonly trust?: ServerTrustConfig;
}

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
        definitionDigest: hashDefinition(entry, namespace),
        approval: serializeApprovalPosture(approvalPosture(entry)),
        effect: toolEffect(tool),
        trust: options.trust?.[tool.serverName] ?? DEFAULT_SERVER_TRUST,
        tool,
        entry,
      } satisfies CatalogEntry;
    })
    .sort((left, right) => compareStrings(left.ref, right.ref));

  const byIdentity = new Map(
    entries.map((entry) => [identityKey(entry.serverName, entry.toolName), entry]),
  );

  // Two distinct identities can render the same ref when a tool name contains
  // the separator. Neither is allowed to win: the loser would be silently
  // impersonated by whichever sorted first.
  const byRef = new Map<string, CatalogEntry>();
  const collidingRefs = new Set<string>();
  for (const entry of entries) {
    if (byRef.has(entry.ref)) collidingRefs.add(entry.ref);
    else byRef.set(entry.ref, entry);
  }
  for (const ref of collidingRefs) byRef.delete(ref);
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
    byIdentity,
    ambiguous,
    collidingRefs,
  };
}

/**
 * A collision-free key for an identity.
 *
 * Length-prefixing the server name means no tool name can forge a different
 * server's key, which `${server}/${tool}` cannot promise.
 */
export function identityKey(serverName: string, toolName: string): string {
  return `${String(serverName.length)}:${serverName}/${toolName}`;
}

/**
 * Resolve a structured identity. No parsing, no guessing — an exact lookup
 * against the catalog, which is what a dispatch decision needs.
 */
export function resolveIdentity(snapshot: CatalogSnapshot, identity: ToolIdentity): ResolveResult {
  const entry = snapshot.byIdentity.get(identityKey(identity.serverName, identity.toolName));
  if (entry) return { ok: true, entry };
  return {
    ok: false,
    error: "unknown_tool",
    message: `No tool "${identity.toolName}" on server "${identity.serverName}". Use code_search to find it.`,
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

  if (snapshot.collidingRefs.has(trimmed)) {
    const candidates = snapshot.entries
      .filter((entry) => entry.ref === trimmed)
      .map((entry) => `${entry.serverName} :: ${entry.toolName}`)
      .sort(compareStrings);
    return {
      ok: false,
      error: "ambiguous_tool",
      message:
        `"${trimmed}" renders from ${String(candidates.length)} different tools, so it cannot ` +
        `identify one. Call by structured identity instead: ${candidates.join(", ")}.`,
      candidates,
    };
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

/**
 * Hash every byte of a tool the model is ever shown.
 *
 * Descriptions are included because they are instructions in practice: a
 * server that rewrites one has changed what the model will do without changing
 * anything the execution contract notices.
 */
function hashDefinition(entry: CodeModeTool, namespace: string): string {
  const tool = entry.tool;
  return sha256(
    canonicalJson({
      serverName: tool.serverName,
      toolName: tool.name,
      namespace,
      title: tool.title ?? null,
      description: tool.description ?? null,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: entry.outputSchema ?? null,
      provenance: entry.outputSchemaProvenance,
      annotations: tool.annotations ?? null,
      meta: tool._meta ?? null,
      approval: serializeApprovalPosture(approvalPosture(entry)),
    }),
  );
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
      (entry) =>
        `${entry.serverName}\t${entry.namespace}\t${entry.toolName}\t${entry.schemaHash}\t` +
        `${entry.definitionDigest}\t${entry.effect}\t${entry.trust}\t${entry.approval}`,
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
