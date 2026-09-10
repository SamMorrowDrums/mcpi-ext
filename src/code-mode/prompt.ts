import { createHash } from "node:crypto";
import type { NamespaceSummary } from "./namespaces.js";
import { SEARCH_TOP_K_DEFAULT } from "./budgets.js";

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
    "Tool names and schemas are omitted. Use `code_search`: `browse` namespaces, `search` for candidates",
    `(${String(SEARCH_TOP_K_DEFAULT)} by default), \`describe\` chosen refs before calling, or \`list\` one namespace.`,
    "Search covers all connected tools; namespaces are hints, not boundaries.",
    "",
    "Every successful `code_search` returns a full `snapshotId`. When execution depends on discovery,",
    "pass that exact full value as `code_execute.snapshotId`. `schemaHash` is per-tool, not a snapshotId,",
    "and truncated IDs cannot execute. On `stale_snapshot`, rerun the relevant search or describe and",
    "use its new full snapshotId. Omit it only to intentionally run unpinned against the current catalog.",
    "",
    "Call a described tool by canonical reference:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server", "example_list", { page: 1 });',
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
    'const result = await codemode.call("example-server", "example_count", {});',
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
    "Plan discovery first, then use one `code_execute` for all calls and exact work. If an unknown",
    "shape blocks it, use `codemode.inspect(result)` in one bounded inspection execution, then one",
    "corrected retry. Retries do not expand the per-execution tool-call budget.",
    "",
    "Write tools pause for approval mid-script. Sanity-check the result before reporting.",
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
