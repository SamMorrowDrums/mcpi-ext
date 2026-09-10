import type { McpTool } from "../mcp/index.js";

/**
 * Draft `_meta` keys a server may use to declare which toolset a tool belongs to.
 *
 * There is no ratified MCP toolset extension. These keys are read opportunistically
 * and never written, so a server that declares nothing is not misreported as having
 * declared something — it falls through to the operator-config and server-only
 * sources below.
 *
 * Checked in order; the first key present on a tool wins.
 */
export const TOOLSET_META_KEYS = Object.freeze([
  "com.github.mcp.experimental/toolset",
  "io.modelcontextprotocol/toolset",
  "dev.mcpi/toolset",
] as const);

/**
 * Where a namespace summary came from.
 *
 * The order is a trust order, not a quality order: an operator writing a
 * namespace block into config is making an explicit, reviewable declaration,
 * which is why it outranks anything this client could infer from tool names.
 */
export type NamespaceSource = "server-declared" | "operator-config" | "server-only";

/** A toolset declaration, as declared by a server or an operator. */
export interface NamespaceDeclaration {
  readonly id: string;
  readonly title?: string;
  readonly summary?: string;
  /**
   * Declared effect class of the toolset's live surface.
   *
   * Servers may compute this from the tools actually registered for the
   * request, so it can legitimately differ between sessions with different
   * filters. It describes the live surface, not a static catalog.
   */
  readonly effects?: string;
  /** Parent toolset id, for hierarchy. Flat ids, hierarchy by reference. */
  readonly parent?: string;
}

/**
 * A namespace as rendered into the pinned turn-0 prompt.
 *
 * Deliberately carries no tool names and no counts. Everything here is
 * *declared*, so adding, removing, or renaming tools inside an existing
 * namespace cannot change these bytes — which is what makes the rendered
 * block hash-stable across catalog churn.
 */
export interface NamespaceSummary {
  readonly serverName: string;
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly effects?: string;
  readonly parent?: string;
  readonly source: NamespaceSource;
  /** Set when tools in one namespace declared conflicting metadata. */
  readonly conflict?: string;
}

/** Operator-curated namespace declarations, keyed by server name. */
export type OperatorNamespaces = Readonly<Record<string, readonly NamespaceDeclaration[]>>;

/** Minimal server identity used for the server-only fallback. */
export interface ServerIdentity {
  readonly title?: string;
  readonly summary?: string;
}

export interface DeriveNamespacesOptions {
  readonly operator?: OperatorNamespaces;
  readonly identities?: Readonly<Record<string, ServerIdentity>>;
}

/**
 * Contract version this client understands.
 *
 * A declaration carrying a higher major version is ignored rather than parsed
 * optimistically. The fields might well line up, but "the keys I know are still
 * there" is not the same as "the meaning is unchanged" — and a v2 that redefined
 * `effect` would be silently misread as a v1 safety claim. Falling through to
 * operator config or the server-only summary is the honest failure: it says
 * "this client does not understand you" instead of guessing.
 */
export const SUPPORTED_TOOLSET_VERSION = 1;

const MAX_SUMMARY_CHARS = 160;
const MAX_TITLE_CHARS = 60;
const MAX_EFFECTS_CHARS = 40;

/** Namespace id used when a server declares nothing at all. */
export function serverOnlyNamespaceId(serverName: string): string {
  return serverName;
}

/**
 * Read a tool's declared toolset, if it declares one.
 *
 * Accepts either a bare string id or an object with optional title/summary/effects,
 * because a server that only knows its toolset ids should not have to invent prose
 * to participate.
 */
export function readToolsetDeclaration(tool: McpTool): NamespaceDeclaration | undefined {
  const meta = (tool as { _meta?: Record<string, unknown> })._meta;
  if (!meta || typeof meta !== "object") return undefined;

  for (const key of TOOLSET_META_KEYS) {
    const raw = meta[key];
    if (typeof raw === "string") {
      const id = raw.trim();
      if (id) return { id };
      continue;
    }
    if (raw && typeof raw === "object") {
      const record = raw as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      if (!id) continue;
      // Absent `v` is treated as v1: the field was added to the contract after
      // the shape was, and a server that omits it is not claiming v2.
      const version = typeof record.v === "number" ? record.v : SUPPORTED_TOOLSET_VERSION;
      if (!Number.isInteger(version) || version > SUPPORTED_TOOLSET_VERSION) continue;
      // `namespace` is read as display metadata only, never as identity: the
      // server cannot know the name an operator configured it under, so the
      // canonical path is always built client-side from serverName + id.
      return {
        id,
        ...pickString(record.title, MAX_TITLE_CHARS, "title"),
        ...pickString(record.summary, MAX_SUMMARY_CHARS, "summary"),
        ...pickString(record.effect ?? record.effects, MAX_EFFECTS_CHARS, "effects"),
        ...pickString(record.parent, MAX_TITLE_CHARS, "parent"),
      };
    }
  }
  return undefined;
}

/**
 * Resolve every connected server to its namespace summaries.
 *
 * Source order per server: server-declared metadata, then operator config, then
 * a single server-only namespace. The fallback is deliberately *not* derived
 * from tool names: a heuristic grouping would be enumeration wearing a
 * declaration's clothes, and it would churn the pinned prompt every time the
 * server shipped a tool. Heuristics belong in search results, where volatility
 * is free.
 */
export function deriveNamespaces(
  tools: readonly McpTool[],
  options: DeriveNamespacesOptions = {},
): NamespaceSummary[] {
  const serverNames = new Set<string>(tools.map((tool) => tool.serverName));
  for (const name of Object.keys(options.operator ?? {})) serverNames.add(name);
  for (const name of Object.keys(options.identities ?? {})) serverNames.add(name);

  const summaries: NamespaceSummary[] = [];
  for (const serverName of [...serverNames].sort(compareStrings)) {
    const serverTools = tools.filter((tool) => tool.serverName === serverName);
    const declared = collectDeclared(serverName, serverTools);
    if (declared.length > 0) {
      summaries.push(...declared);
      continue;
    }

    const operator = options.operator?.[serverName];
    if (operator && operator.length > 0) {
      summaries.push(...collectOperator(serverName, operator));
      continue;
    }

    summaries.push(serverOnlySummary(serverName, options.identities?.[serverName]));
  }
  return summaries;
}

/** Which namespace a tool belongs to, given the derived summaries for its server. */
export function namespaceForTool(tool: McpTool, summaries: readonly NamespaceSummary[]): string {
  const declared = readToolsetDeclaration(tool);
  if (declared) {
    const match = summaries.find(
      (summary) => summary.serverName === tool.serverName && summary.id === declared.id,
    );
    if (match) return match.id;
  }

  const operator = summaries.find(
    (summary) =>
      summary.serverName === tool.serverName &&
      summary.source === "operator-config" &&
      summary.id === declared?.id,
  );
  if (operator) return operator.id;

  const serverScoped = summaries.filter((summary) => summary.serverName === tool.serverName);
  const fallback = serverScoped.find((summary) => summary.source === "server-only");
  return fallback?.id ?? serverOnlyNamespaceId(tool.serverName);
}

function collectDeclared(serverName: string, tools: readonly McpTool[]): NamespaceSummary[] {
  const byId = new Map<string, NamespaceDeclaration[]>();
  for (const tool of tools) {
    const declaration = readToolsetDeclaration(tool);
    if (!declaration) continue;
    const bucket = byId.get(declaration.id);
    if (bucket) bucket.push(declaration);
    else byId.set(declaration.id, [declaration]);
  }

  return [...byId.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([id, declarations]) => reconcile(serverName, id, declarations, "server-declared"));
}

function collectOperator(
  serverName: string,
  declarations: readonly NamespaceDeclaration[],
): NamespaceSummary[] {
  const byId = new Map<string, NamespaceDeclaration[]>();
  for (const declaration of declarations) {
    const id = declaration.id.trim();
    if (!id) continue;
    const bucket = byId.get(id);
    if (bucket) bucket.push(declaration);
    else byId.set(id, [declaration]);
  }

  return [...byId.entries()]
    .sort(([left], [right]) => compareStrings(left, right))
    .map(([id, group]) => reconcile(serverName, id, group, "operator-config"));
}

/**
 * Collapse many declarations of one namespace into one summary.
 *
 * Consistent declarations — the intended contract — collapse to themselves, so
 * the result does not depend on which tools happen to be present. When servers
 * disagree we take the lexicographically smallest value for determinism and
 * record the conflict rather than silently picking a winner.
 */
function reconcile(
  serverName: string,
  id: string,
  declarations: readonly NamespaceDeclaration[],
  source: NamespaceSource,
): NamespaceSummary {
  const titles = distinct(declarations.map((entry) => entry.title));
  const descriptions = distinct(declarations.map((entry) => entry.summary));
  const effects = distinct(declarations.map((entry) => entry.effects));
  const parents = distinct(declarations.map((entry) => entry.parent));

  const conflicting = [
    titles.length > 1 ? "title" : undefined,
    descriptions.length > 1 ? "summary" : undefined,
    effects.length > 1 ? "effects" : undefined,
    parents.length > 1 ? "parent" : undefined,
  ].filter((field): field is string => field !== undefined);

  return {
    serverName,
    id,
    title: titles[0] ?? id,
    ...(descriptions[0] !== undefined ? { summary: descriptions[0] } : {}),
    ...(effects[0] !== undefined ? { effects: effects[0] } : {}),
    ...(parents[0] !== undefined && parents[0] !== id ? { parent: parents[0] } : {}),
    source,
    ...(conflicting.length > 0
      ? { conflict: `conflicting declared ${conflicting.join(", ")}; using lowest sorted value` }
      : {}),
  };
}

function serverOnlySummary(serverName: string, identity?: ServerIdentity): NamespaceSummary {
  const title = clamp(identity?.title, MAX_TITLE_CHARS) ?? serverName;
  const summary = clamp(identity?.summary, MAX_SUMMARY_CHARS);
  return {
    serverName,
    id: serverOnlyNamespaceId(serverName),
    title,
    ...(summary ? { summary } : {}),
    source: "server-only",
  };
}

function distinct(values: readonly (string | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))].sort(
    compareStrings,
  );
}

function pickString(
  value: unknown,
  max: number,
  key: "title" | "summary" | "effects" | "parent",
): Record<string, string> {
  const clamped = typeof value === "string" ? clamp(value, max) : undefined;
  return clamped ? { [key]: clamped } : {};
}

function clamp(value: string | undefined, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (!collapsed) return undefined;
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
