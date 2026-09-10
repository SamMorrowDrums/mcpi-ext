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
    "Use when a task needs exact computation or control flow: math, aggregation, looping over",
    "results, data transformation, or chaining several MCP tool calls with logic in between.",
    "",
    "`code_execute` runs vanilla JavaScript in a sandboxed V8 isolate. Concretely, that covers:",
    "",
    "1. **Arbitrary computation** — math, string manipulation, date arithmetic, data transformation.",
    "   No MCP tools needed; plain JS works.",
    "2. **Multi-tool aggregation** — counting, filtering, trending, or transforming results across",
    "   many tool calls. Write a loop inside one `code_execute` rather than making many separate calls.",
    "3. **Pagination** — fetch batches in a loop until exhausted, then compute over the full dataset.",
    "",
    "For a single tool call with no computation, provider-native search plus a direct proxy fits.",
    "Use tool-cli for that one-shot only when shell discovery or composition is itself useful; code",
    "mode earns its overhead when there is exact logic between calls.",
    "",
    "### Finding tools",
    "",
    "**Tool names and schemas are not listed in this prompt.** There may be hundreds; loading them",
    "all costs more than any single task needs. Discover the few that matter, then call them:",
    "",
    '1. `code_search` with `op: "browse"` — the namespaces below, with their declared capability.',
    `2. \`code_search\` with \`op: "search"\` — rank tools by query (${String(SEARCH_TOP_K_DEFAULT)} hits by default).`,
    "   Returns names, effect class, and parameter names — enough to choose, not enough to call.",
    '3. `code_search` with `op: "describe"` — exact signatures for the refs you chose. Do this before',
    "   calling anything; a call built from a search hit alone is a guess.",
    '4. `code_search` with `op: "list"` — every tool in one namespace, when you want the full set.',
    "",
    "Search covers every connected tool regardless of namespace, so a tool in an unexpected place is",
    "still findable. Namespaces are a routing hint, not a boundary.",
    "",
    "Every successful `code_search` response prints a full `snapshotId`. Pass that exact full value",
    "as `code_execute.snapshotId` when the code depends on what you discovered. `schemaHash` labels a",
    "single tool contract and is not a snapshotId; truncated IDs are not executable. On",
    "`stale_snapshot`, rerun the relevant search or describe operation and use its new full snapshotId.",
    "Omit snapshotId only when you intentionally accept an unpinned run against the current catalog;",
    "that gives up protection against a catalog change between discovery and execution.",
    "",
    "### Calling tools",
    "",
    "Inside `code_execute`, call a described tool by its canonical reference:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server", "example_list", { page: 1 });',
    "```",
    "",
    "`codemode.<tool_name>(args)` also works when that name is unique across all connected servers.",
    "When it is not, the shorthand is withheld and you must use `codemode.call` — two servers can",
    "publish the same tool name, and guessing between them is how you write to the wrong place.",
    "",
    "### Results",
    "",
    "Every MCP tool call returns the raw MCP CallToolResult envelope. A declared output schema types",
    "`result.structuredContent`; it does not replace the envelope or move its fields to the top level.",
    "`content`, `_meta`, `isError`, resource blocks, mixed content, and text-only results are preserved.",
    "Even for a declared schema, an `isError` result may omit structuredContent, so guard it:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server", "example_count", {});',
    "if (result.isError || result.structuredContent === undefined) {",
    "  return { isError: result.isError, content: result.content };",
    "}",
    "return result.structuredContent.total_count;",
    "```",
    "",
    "When no output schema is declared, `structuredContent?: unknown`. Inspect the envelope and then",
    "the structured value when present rather than assuming either exists:",
    "",
    "```javascript",
    'const result = await codemode.call("example-server", "example_list", { page: 1 });',
    "console.log(codemode.inspect(result));  // keys, types, array lengths, sample values",
    "if (result.structuredContent !== undefined) {",
    "  console.log(codemode.inspect(result.structuredContent));",
    "}",
    "```",
    "",
    "### How to write code",
    "",
    "Write vanilla JavaScript (not TypeScript, not Node.js). No `require`, `import`, `fetch`, `fs`,",
    "`process`, or any Node.js/browser APIs. The only external API is the `codemode` namespace.",
    "Always `return` the final result.",
    "",
    "Plan discovery first, then make one `code_execute` call that does the whole job. Loops,",
    "comparisons, pagination, and aggregation all happen inside that single execution.",
    "",
    "```javascript",
    "const counts = {};",
    "let page = 1;",
    "while (true) {",
    '  const result = await codemode.call("example-server", "example_list", { page, perPage: 100 });',
    "  if (result.isError || result.structuredContent === undefined) {",
    '    throw new Error("example_list returned no structured data");',
    "  }",
    "  const items = result.structuredContent.items;",
    "  for (const item of items) {",
    "    counts[item.category] = (counts[item.category] || 0) + 1;",
    "  }",
    "  if (items.length < 100) break;",
    "  page++;",
    "}",
    "return counts;",
    "```",
    "",
    "If an unknown result shape blocks the first attempt, one bounded inspection execution and one corrected retry",
    "are reasonable. Repeated executions are not a way around the per-execution tool-call budget;",
    "narrow the query or paginate more coarsely instead.",
    "",
    "Write tools are callable from code mode and pause for approval mid-script. After producing a",
    "result, sanity-check it before reporting.",
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
