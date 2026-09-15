import { createHash } from "node:crypto";
import type { NamespaceSummary } from "./namespaces.js";

/**
 * Render the namespace block for the turn-0 prompt.
 *
 * Carries only declared identity: server, namespace, title, one-line summary,
 * declared effect class. No tool names, no tool descriptions, no counts. That
 * is what makes this block's hash invariant when a server adds, removes, or
 * renames tools inside an existing namespace — the churn that used to rewrite
 * a 26k-token catalog on every turn now changes nothing here at all.
 */
export function renderNamespaceBlock(namespaces: readonly NamespaceSummary[]): string {
  if (namespaces.length === 0) {
    return "No MCP servers are connected. Code mode still runs pure JavaScript computation.";
  }

  const byServer = new Map<string, NamespaceSummary[]>();
  for (const summary of namespaces) {
    const bucket = byServer.get(summary.serverName);
    if (bucket) bucket.push(summary);
    else byServer.set(summary.serverName, [summary]);
  }

  const lines: string[] = [];
  for (const serverName of [...byServer.keys()].sort(compareStrings)) {
    lines.push(`${serverName}:`);
    const summaries = [...(byServer.get(serverName) ?? [])].sort((left, right) =>
      compareStrings(left.id, right.id),
    );
    for (const summary of summaries) {
      const parts = [`  ${summary.id}`];
      if (summary.effects) parts.push(`[${summary.effects}]`);
      if (summary.title && summary.title !== summary.id) parts.push(`— ${summary.title}`);
      lines.push(parts.join(" "));
      if (summary.summary) lines.push(`    ${summary.summary}`);
    }
  }
  return lines.join("\n");
}

/** SHA-256 of the rendered namespace block, for byte-stability assertions. */
export function hashNamespaceBlock(namespaces: readonly NamespaceSummary[]): string {
  return createHash("sha256").update(renderNamespaceBlock(namespaces), "utf8").digest("hex");
}

export interface PromptSectionOptions {
  readonly namespaces: readonly NamespaceSummary[];
  readonly sandboxAvailable: boolean;
}

/**
 * The complete `<code_mode>` section.
 *
 * Pinned once at session start. Nothing per-tool appears here: the model is
 * told how to find tools, not given all of them, because a catalog that is
 * already in the prompt cannot be discovered progressively.
 */
export function renderPromptSection(options: PromptSectionOptions): string {
  return [
    "",
    "<code_mode>",
    "## Code mode",
    "",
    "Use for exact computation or control flow: arithmetic, filtering, aggregation, joins, pagination,",
    "or reduction across MCP calls. It also runs pure JavaScript with no MCP server.",
    "",
    "### Discover and execute",
    "",
    "Tool schemas are omitted. Use `code_search` to `browse`, `search`, `describe` refs, or `list` one",
    "namespace. All connected tools are searchable; namespaces are hints.",
    "",
    "Each `code_search` returns a full `snapshotId`; after discovery pass it as `code_execute.snapshotId`.",
    "`schemaHash` and truncated IDs are invalid. On `stale_snapshot`, repeat the relevant search/describe.",
    "Omit `snapshotId` only for an intentional unpinned run against the current catalog.",
    "",
    "Call by canonical reference:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server/example_list", { page: 1 });',
    "```",
    "",
    "`codemode.<tool_name>(args)` works only for names unique across connected servers.",
    "",
    "### Results",
    "",
    "Each call returns the raw MCP `CallToolResult` envelope. A declared output schema types only the",
    "optional `result.structuredContent`; `content`, `_meta`, and `isError` remain on the envelope.",
    "Check errors and presence before using declared data; unknown outputs may be text-only:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server/example_count", {});',
    "if (result.isError || result.structuredContent === undefined) {",
    "  return { isError: result.isError, content: result.content };",
    "}",
    "return result.structuredContent.total_count;",
    "```",
    "",
    "### How to write code",
    "",
    "Write vanilla JavaScript, not TypeScript or Node.js. No `require`, `import`, `fetch`, `fs`,",
    "`process`, or browser APIs; only `codemode` is external. Always return the final result.",
    "",
    "Use one `code_execute` for the complete calculation. For an unknown result shape, inspect once,",
    "then make at most one corrected retry; retries do not expand call budgets.",
    "",
    "Run independent read calls concurrently with `Promise.all`; keep dependent calls, pagination whose",
    "next cursor depends on the previous page, and all writes sequential:",
    '`const results = await Promise.all(items.map(x => codemode.call("server/read_item", { id: x.id })));`',
    "The runtime enforces per-server concurrency and rate-limit backoff; do not serialize independent",
    "reads or implement sleeps/throttling in generated code.",
    "",
    "### Available namespaces",
    "",
    renderNamespaceBlock(options.namespaces),
    "</code_mode>",
  ].join("\n");
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
