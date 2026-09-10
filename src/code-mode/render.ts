import { DISCOVERY_RESPONSE_BYTE_CAP } from "./budgets.js";
import type {
  BrowseResult,
  DescribeResult,
  DiscoveryError,
  ListResult,
  SearchResult,
  ToolHit,
} from "./discovery.js";

type DiscoveryResult = BrowseResult | ListResult | SearchResult | DescribeResult | DiscoveryError;

/**
 * Render a discovery result as compact deterministic text.
 *
 * Text, not JSON: these results are read by a model, and the row form costs
 * roughly half the tokens of the equivalent JSON while carrying the same
 * fields. Identical input always produces identical bytes.
 */
export function renderDiscovery(result: unknown): string {
  const value = result as DiscoveryResult;

  if (!("op" in value)) return renderError(value);

  switch (value.op) {
    case "browse":
      return cap(renderBrowse(value));
    case "list":
      return cap(renderList(value));
    case "search":
      return cap(renderSearch(value));
    case "describe":
      return cap(renderDescribe(value));
  }
}

function renderError(error: DiscoveryError): string {
  const lines = [`error: ${error.error}`, error.message];
  if (error.candidates && error.candidates.length > 0) {
    lines.push(`candidates: ${error.candidates.join(", ")}`);
  }
  return lines.join("\n");
}

function renderBrowse(result: BrowseResult): string {
  const lines = [snapshotHeader(result.snapshotId), ""];
  if (result.namespaces.length === 0) {
    lines.push(
      "No MCP namespaces are available. No servers are connected, or none expose callable tools.",
    );
    return lines.join("\n");
  }

  lines.push("namespaces:");
  for (const view of result.namespaces) {
    const parts = [`  ${view.ref}`, `[${String(view.toolCount)} tools]`];
    if (view.effects) parts.push(`(${view.effects})`);
    if (view.parent) parts.push(`child of ${view.parent}`);
    parts.push(`— ${view.summary ?? view.title}`);
    if (view.source !== "server-declared") parts.push(`{${view.source}}`);
    lines.push(parts.join(" "));
  }
  lines.push("", result.note);
  return lines.join("\n");
}

function renderList(result: ListResult): string {
  const scope = result.namespace ?? result.server ?? "all namespaces";
  const lines = [snapshotHeader(result.snapshotId), ""];
  if (result.tools.length === 0) {
    lines.push(`No tools matched ${scope}. Use op=browse to see available namespaces.`);
    return lines.join("\n");
  }

  lines.push(`${String(result.totalMatches)} tool(s) in ${scope}:`, ...result.tools.map(renderHit));
  lines.push(
    "",
    pageFooter(result.truncated, result.totalMatches, result.tools.length, result.nextCursor),
  );
  return lines.join("\n");
}

function renderSearch(result: SearchResult): string {
  const lines = [snapshotHeader(result.snapshotId), ""];
  if (result.hits.length === 0) {
    lines.push(
      `No tools matched "${result.query}". Try op=browse for available namespaces, or different terms — matching is over tool names and descriptions only.`,
    );
    return lines.join("\n");
  }

  lines.push(
    `${String(result.totalMatches)} match(es) for "${result.query}":`,
    ...result.hits.map(renderHit),
  );
  lines.push(
    "",
    pageFooter(result.truncated, result.totalMatches, result.hits.length, result.nextCursor),
  );
  return lines.join("\n");
}

function renderDescribe(result: DescribeResult): string {
  const lines: string[] = [snapshotHeader(result.snapshotId), ""];
  for (const entry of result.signatures) lines.push(entry.signature);

  if (result.unresolved.length > 0) {
    lines.push("", "unresolved:");
    for (const error of result.unresolved) {
      const suffix = error.candidates?.length ? ` candidates: ${error.candidates.join(", ")}` : "";
      lines.push(`  ${error.error}: ${error.message}${suffix}`);
    }
  }

  if (result.truncated) {
    lines.push(
      "",
      "Some refs were dropped: describe accepts a bounded batch. Request the rest separately.",
    );
  }

  lines.push("", `Call with: await codemode.call("<ref>", { ...args })`);
  return lines.join("\n");
}

function renderHit(hit: ToolHit): string {
  const parts = [`  ${hit.ref}(${hit.params})`, `[${hit.effect}]`];
  if (hit.description) parts.push(`— ${hit.description}`);
  return parts.join(" ");
}

function pageFooter(
  truncated: boolean,
  total: number,
  shown: number,
  nextCursor: string | undefined,
): string {
  if (!truncated) return "Use op=describe with these refs for exact parameters before calling.";
  const remaining = total - shown;
  const cursorHint = nextCursor ? ` Pass cursor="${nextCursor}" for the next page.` : "";
  return `${String(remaining)} more not shown.${cursorHint} Use op=describe with any ref for exact parameters.`;
}

function snapshotHeader(snapshotId: string): string {
  return `snapshotId (full; pass as code_execute.snapshotId): ${snapshotId}`;
}

/**
 * Bound the response.
 *
 * A discovery answer that blows the context budget defeats the point of
 * progressive discovery, so an oversized render is truncated on a line
 * boundary and says so rather than silently losing its tail.
 */
function cap(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= DISCOVERY_RESPONSE_BYTE_CAP) return text;

  const lines = text.split("\n");
  const kept: string[] = [];
  let bytes = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (bytes + size > DISCOVERY_RESPONSE_BYTE_CAP - 120) break;
    kept.push(line);
    bytes += size;
  }
  kept.push(
    "",
    "[truncated: response exceeded the discovery byte budget. Narrow with namespace, server, or a smaller limit.]",
  );
  return kept.join("\n");
}
