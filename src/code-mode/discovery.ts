import {
  CODE_MODE_ERRORS,
  DESCRIBE_BATCH_MAX,
  DISCOVERY_RESPONSE_BYTE_CAP,
  LIST_PAGE_DEFAULT,
  LIST_PAGE_MAX,
  SEARCH_TOP_K_DEFAULT,
  SEARCH_TOP_K_MAX,
  clampBound,
} from "./budgets.js";
import { canonicalJson, resolveTool, type CatalogEntry, type CatalogSnapshot } from "./catalog.js";
import { renderCompactSignature, renderParamNames, renderSearchRow } from "./signatures.js";
import type { NamespaceSummary } from "./namespaces.js";

export interface DiscoveryError {
  readonly error: string;
  readonly message: string;
  readonly candidates?: readonly string[];
}

export interface NamespaceView {
  readonly ref: string;
  readonly server: string;
  readonly namespace: string;
  readonly title: string;
  readonly summary?: string;
  readonly effects?: string;
  readonly parent?: string;
  readonly source: NamespaceSummary["source"];
  readonly toolCount: number;
}

export interface BrowseResult {
  readonly op: "browse";
  readonly snapshotId: string;
  readonly namespaces: readonly NamespaceView[];
  readonly note: string;
}

export interface ToolHit {
  readonly ref: string;
  readonly namespace: string;
  readonly effect: string;
  readonly params: string;
  readonly description?: string;
}

export interface ListResult {
  readonly op: "list";
  readonly snapshotId: string;
  readonly namespace?: string;
  readonly server?: string;
  readonly tools: readonly ToolHit[];
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface SearchResult {
  readonly op: "search";
  readonly snapshotId: string;
  readonly query: string;
  readonly hits: readonly ToolHit[];
  readonly totalMatches: number;
  readonly truncated: boolean;
  readonly nextCursor?: string;
}

export interface DescribeResult {
  readonly op: "describe";
  readonly snapshotId: string;
  readonly signatures: readonly {
    readonly ref: string;
    readonly signature: string;
    /** The schema this signature was rendered from, so a later call can detect drift. */
    readonly schemaHash: string;
  }[];
  readonly unresolved: readonly DiscoveryError[];
  readonly truncated: boolean;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly namespace?: string;
  readonly server?: string;
  readonly effect?: string;
  readonly cursor?: string;
}

export interface ListOptions {
  readonly limit?: number;
  readonly namespace?: string;
  readonly server?: string;
  readonly effect?: string;
  readonly cursor?: string;
}

/**
 * Namespace overview. This is the only unfiltered enumeration Code Mode offers,
 * and it deliberately returns namespaces rather than tools.
 */
export function browseNamespaces(
  snapshot: CatalogSnapshot,
  options: { readonly parent?: string } = {},
): BrowseResult {
  const parent = options.parent?.trim();
  const selected = snapshot.namespaces.filter((summary) =>
    parent ? summary.parent === parent : true,
  );

  const namespaces = selected.map((summary) => ({
    ref: `${summary.serverName}/${summary.id}`,
    server: summary.serverName,
    namespace: summary.id,
    title: summary.title,
    ...(summary.summary ? { summary: summary.summary } : {}),
    ...(summary.effects ? { effects: summary.effects } : {}),
    ...(summary.parent ? { parent: summary.parent } : {}),
    source: summary.source,
    toolCount: snapshot.entries.filter(
      (entry) => entry.serverName === summary.serverName && entry.namespace === summary.id,
    ).length,
  }));

  return {
    op: "browse",
    snapshotId: snapshot.snapshotId,
    namespaces,
    note: "Narrow with search (query) or list (namespace). Tool names are not listed unfiltered.",
  };
}

/**
 * List tool names within a namespace, server, or effect class.
 *
 * Requires a filter by design: an unfiltered list would be the full catalog
 * arriving through the back door, which is the thing this whole surface exists
 * to prevent.
 */
export function listTools(
  snapshot: CatalogSnapshot,
  options: ListOptions = {},
): ListResult | DiscoveryError {
  const filters = readFilters(options);
  if (!filters.namespace && !filters.server && !filters.effect) {
    return {
      error: CODE_MODE_ERRORS.INVALID_ARGUMENTS,
      message:
        "list requires a namespace, server, or effect filter. Use browse to see namespaces first.",
    };
  }

  const matched = applyFilters(snapshot.entries, filters);
  const pageSize = clampBound(options.limit, LIST_PAGE_DEFAULT, LIST_PAGE_MAX);
  const key = cursorKey(snapshot.snapshotId, "list", "", filters, pageSize);

  const offset = readCursor(options.cursor, key);
  if (typeof offset !== "number") return offset;

  const page = matched.slice(offset, offset + pageSize);
  const capped = applyByteCap(page, (entries) =>
    canonicalJson(entries.map((entry) => toHit(entry))),
  );

  const consumed = offset + capped.length;
  return {
    op: "list",
    snapshotId: snapshot.snapshotId,
    ...(filters.namespace ? { namespace: filters.namespace } : {}),
    ...(filters.server ? { server: filters.server } : {}),
    tools: capped.map(toHit),
    totalMatches: matched.length,
    truncated: consumed < matched.length,
    ...(consumed < matched.length ? { nextCursor: writeCursor(key, consumed) } : {}),
  };
}

/**
 * Rank tools against a query.
 *
 * Ordering is exact name, then prefix, then substring, then BM25 over name and
 * description, with the canonical ref as a total-order tie-break so identical
 * scores never reorder between calls.
 */
export function searchTools(
  snapshot: CatalogSnapshot,
  query: string,
  options: SearchOptions = {},
): SearchResult | DiscoveryError {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      error: CODE_MODE_ERRORS.INVALID_ARGUMENTS,
      message: "search requires a non-empty query. Use browse to see namespaces.",
    };
  }

  const filters = readFilters(options);
  const candidates = applyFilters(snapshot.entries, filters);
  const ranked = rank(candidates, trimmed);

  const pageSize = clampBound(options.limit, SEARCH_TOP_K_DEFAULT, SEARCH_TOP_K_MAX);
  const key = cursorKey(snapshot.snapshotId, "search", trimmed, filters, pageSize);

  const offset = readCursor(options.cursor, key);
  if (typeof offset !== "number") return offset;

  const page = ranked.slice(offset, offset + pageSize);
  const capped = applyByteCap(page, (entries) => canonicalJson(entries.map((e) => toHit(e))));
  const consumed = offset + capped.length;

  return {
    op: "search",
    snapshotId: snapshot.snapshotId,
    query: trimmed,
    hits: capped.map(toHit),
    totalMatches: ranked.length,
    truncated: consumed < ranked.length,
    ...(consumed < ranked.length ? { nextCursor: writeCursor(key, consumed) } : {}),
  };
}

/** Return exact compact signatures for explicitly named refs. */
export function describeTools(
  snapshot: CatalogSnapshot,
  refs: readonly string[],
): DescribeResult | DiscoveryError {
  if (refs.length === 0) {
    return {
      error: CODE_MODE_ERRORS.INVALID_ARGUMENTS,
      message: "describe requires at least one tool reference.",
    };
  }

  const truncated = refs.length > DESCRIBE_BATCH_MAX;
  const requested = refs.slice(0, DESCRIBE_BATCH_MAX);

  const signatures: { ref: string; signature: string; schemaHash: string }[] = [];
  const unresolved: DiscoveryError[] = [];

  for (const reference of requested) {
    const resolved = resolveTool(snapshot, reference);
    if (!resolved.ok) {
      unresolved.push({
        error: resolved.error,
        message: resolved.message,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      });
      continue;
    }
    signatures.push({
      ref: resolved.entry.ref,
      signature: renderCompactSignature(resolved.entry),
      schemaHash: resolved.entry.schemaHash,
    });
  }

  return {
    op: "describe",
    snapshotId: snapshot.snapshotId,
    signatures,
    unresolved,
    truncated,
  };
}

interface Filters {
  readonly namespace?: string;
  readonly server?: string;
  readonly effect?: string;
}

function readFilters(options: ListOptions | SearchOptions): Filters {
  return {
    ...(options.namespace?.trim() ? { namespace: options.namespace.trim() } : {}),
    ...(options.server?.trim() ? { server: options.server.trim() } : {}),
    ...(options.effect?.trim() ? { effect: options.effect.trim() } : {}),
  };
}

function applyFilters(entries: readonly CatalogEntry[], filters: Filters): CatalogEntry[] {
  return entries.filter((entry) => {
    if (filters.server && entry.serverName !== filters.server) return false;
    if (filters.effect && entry.effect !== filters.effect) return false;
    if (filters.namespace) {
      const qualified = `${entry.serverName}/${entry.namespace}`;
      if (entry.namespace !== filters.namespace && qualified !== filters.namespace) return false;
    }
    return true;
  });
}

function toHit(entry: CatalogEntry): ToolHit {
  const description = renderSearchRow(entry).split("\n")[1]?.trim();
  return {
    ref: entry.ref,
    namespace: entry.namespace,
    effect: entry.effect,
    params: renderParamNames(entry),
    ...(description ? { description } : {}),
  };
}

const TIER_EXACT = 1_000_000;
const TIER_PREFIX = 100_000;
const TIER_SUBSTRING = 10_000;

function rank(entries: readonly CatalogEntry[], query: string): CatalogEntry[] {
  const lowered = query.toLowerCase();
  const terms = tokenize(query);
  const scorer = buildBm25(entries, terms);

  return entries
    .map((entry) => {
      const name = entry.toolName.toLowerCase();
      let score = scorer(entry);
      if (name === lowered) score += TIER_EXACT;
      else if (name.startsWith(lowered)) score += TIER_PREFIX;
      else if (name.includes(lowered)) score += TIER_SUBSTRING;
      return { entry, score };
    })
    .filter((scored) => scored.score > 0)
    .sort((left, right) =>
      right.score !== left.score
        ? right.score - left.score
        : left.entry.ref < right.entry.ref
          ? -1
          : left.entry.ref > right.entry.ref
            ? 1
            : 0,
    )
    .map((scored) => scored.entry);
}

const BM25_K1 = 1.2;
const BM25_B = 0.75;

function buildBm25(
  entries: readonly CatalogEntry[],
  terms: readonly string[],
): (entry: CatalogEntry) => number {
  const documents = new Map<string, string[]>();
  for (const entry of entries) {
    documents.set(entry.ref, tokenize(`${entry.toolName} ${entry.tool.description ?? ""}`));
  }

  const totalLength = [...documents.values()].reduce((sum, tokens) => sum + tokens.length, 0);
  const averageLength = documents.size > 0 ? totalLength / documents.size : 0;

  const documentFrequency = new Map<string, number>();
  for (const term of terms) {
    if (documentFrequency.has(term)) continue;
    let count = 0;
    for (const tokens of documents.values()) if (tokens.includes(term)) count += 1;
    documentFrequency.set(term, count);
  }

  return (entry: CatalogEntry) => {
    const tokens = documents.get(entry.ref) ?? [];
    if (tokens.length === 0 || averageLength === 0) return 0;

    let score = 0;
    for (const term of terms) {
      const frequency = tokens.filter((token) => token === term).length;
      if (frequency === 0) continue;
      const df = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.size - df + 0.5) / (df + 0.5));
      const denominator =
        frequency + BM25_K1 * (1 - BM25_B + (BM25_B * tokens.length) / averageLength);
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
    }
    return score;
  };
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

/**
 * Trim a page until its serialized form fits the byte cap.
 *
 * Applied after ranking so the highest-scoring hits survive.
 */
function applyByteCap(
  entries: readonly CatalogEntry[],
  serialize: (entries: readonly CatalogEntry[]) => string,
): CatalogEntry[] {
  let page = [...entries];
  while (
    page.length > 1 &&
    Buffer.byteLength(serialize(page), "utf8") > DISCOVERY_RESPONSE_BYTE_CAP
  ) {
    page = page.slice(0, -1);
  }
  return page;
}

/**
 * Bind a cursor to everything that would change its meaning.
 *
 * A cursor from a different snapshot, query, filter, or page size is refused
 * rather than silently reinterpreted against the current one.
 */
function cursorKey(
  snapshotId: string,
  op: string,
  query: string,
  filters: Filters,
  pageSize: number,
): string {
  return canonicalJson({ snapshotId, op, query, filters, pageSize });
}

function writeCursor(key: string, offset: number): string {
  return Buffer.from(canonicalJson({ key, offset }), "utf8").toString("base64url");
}

function readCursor(cursor: string | undefined, key: string): number | DiscoveryError {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      key?: unknown;
      offset?: unknown;
    };
    if (decoded.key !== key || typeof decoded.offset !== "number" || decoded.offset < 0) {
      return {
        error: CODE_MODE_ERRORS.STALE_CURSOR,
        message:
          "This cursor belongs to a different snapshot, query, filter, or page size. Re-run the search without a cursor.",
      };
    }
    return decoded.offset;
  } catch {
    return {
      error: CODE_MODE_ERRORS.STALE_CURSOR,
      message: "Cursor is not readable. Re-run the search without a cursor.",
    };
  }
}
