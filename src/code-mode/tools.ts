import type { AgentToolResult, ExtensionContext } from "@sammorrowdrums/mcpi";
import { Type, type Static } from "typebox";
import { DESCRIBE_BATCH_MAX, LIST_PAGE_MAX, SEARCH_TOP_K_MAX } from "./budgets.js";
import { renderDiscovery } from "./render.js";
import type { ExecuteResult } from "./executor.js";
import type { CodeModeManager } from "./index.js";

/**
 * `code_search` takes typed parameters, not code.
 *
 * The released version accepted JavaScript and ran it through the full
 * execution path — a dispatch surface wearing a search label. Discovery is a
 * deterministic query over a local snapshot, so it is expressed as one.
 */
const DiscoveryInput = Type.Object({
  op: Type.Union(
    [
      Type.Literal("browse"),
      Type.Literal("search"),
      Type.Literal("list"),
      Type.Literal("describe"),
    ],
    {
      description:
        "browse: namespaces available (start here). search: rank tools by relevance to a query. list: page through one namespace or server. describe: exact call signature and parameters for specific tools.",
    },
  ),
  query: Type.Optional(
    Type.String({ description: "Search terms. Required for op=search, ignored otherwise." }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description: `Canonical tool references ("server/tool") to describe. Required for op=describe. Max ${String(DESCRIBE_BATCH_MAX)}.`,
      maxItems: DESCRIBE_BATCH_MAX,
    }),
  ),
  namespace: Type.Optional(
    Type.String({ description: "Restrict results to this namespace ref from op=browse." }),
  ),
  server: Type.Optional(Type.String({ description: "Restrict results to this MCP server." })),
  effect: Type.Optional(
    Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("unknown")], {
      description: "Restrict results by declared effect class.",
    }),
  ),
  parent: Type.Optional(
    Type.String({ description: "For op=browse, list only children of this namespace." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Maximum results. search caps at ${String(SEARCH_TOP_K_MAX)}, list at ${String(LIST_PAGE_MAX)}.`,
      minimum: 1,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: "Opaque pagination cursor from a previous response." }),
  ),
});

export type DiscoveryQuery = Static<typeof DiscoveryInput>;

const CodeInput = Type.Object({
  code: Type.String({
    description:
      "JavaScript to execute. Call tools with `await codemode.call('server', 'tool', args)`. Discover inside the sandbox with `codemode.browse()`, `codemode.search(q)`, `codemode.describe([refs])`. Always `return` your final result. No filesystem, network, or Node.js APIs.",
  }),
  snapshotId: Type.Optional(
    Type.String({
      description:
        "The snapshotId from the code_search response you based this code on. Supply it to be told if the catalog changed since, instead of calling against parameters that may have moved.",
    }),
  ),
});

type CodeInputType = Static<typeof CodeInput>;

export interface CodeModeToolDetails {
  executionMs: number;
  logs: string[];
  error?: string;
  message?: string;
  alternatives?: string[];
  candidates?: string[];
  toolName?: string;
  reason?: string;
}

export interface DiscoveryToolDetails {
  executionMs: number;
  op: string;
  snapshotId?: string;
  error?: string;
}

/** Format an ExecuteResult into a tool response. Falls back to logs if result is undefined. */
function formatResult(
  result: ExecuteResult,
  executionMs: number,
  errorPrefix: string,
): AgentToolResult<CodeModeToolDetails> {
  if (result.error) {
    const errorDetails = result.errorDetails ?? {
      error: "execution_failed",
      message: result.error,
    };
    return {
      content: [{ type: "text", text: `${errorPrefix}: ${result.error}` }],
      details: { executionMs, logs: result.logs, ...errorDetails },
    };
  }

  // If code didn't return a value, fall back to captured console output
  const output =
    result.result !== undefined
      ? typeof result.result === "string"
        ? result.result
        : JSON.stringify(result.result, null, 2)
      : result.logs.length > 0
        ? result.logs.join("\n")
        : "(no return value)";

  const logsSection =
    result.result !== undefined && result.logs.length > 0
      ? `\n\nLogs:\n${result.logs.join("\n")}`
      : "";

  return {
    content: [{ type: "text", text: output + logsSection }],
    details: { executionMs, logs: result.logs },
  };
}

/**
 * Create the `code_search` tool for querying the tool catalog.
 *
 * Answers entirely from the local catalog snapshot: no MCP server is contacted
 * and no sandbox is started, so discovery cannot have side effects.
 */
export function createCodeSearchTool(manager: CodeModeManager) {
  return {
    name: "code_search",
    label: "Code Search",
    description:
      "Look up MCP tools available to code_execute. Start with op=browse to see namespaces, op=search to find tools by task, op=list to page through a namespace, and op=describe to get exact parameters before calling. The whole catalogue is searchable whether or not any skill has been loaded. Read-only: contacts no server and runs no code.",
    parameters: DiscoveryInput,

    async execute(
      _toolCallId: string,
      params: DiscoveryQuery,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<DiscoveryToolDetails>> {
      const start = performance.now();
      const { op, ...rest } = params;
      const result = manager.discover(op, rest as Record<string, unknown>);
      const executionMs = Math.round(performance.now() - start);
      const record = result as Record<string, unknown>;

      return {
        content: [{ type: "text", text: renderDiscovery(result) }],
        details: {
          executionMs,
          op,
          ...(typeof record.snapshotId === "string" ? { snapshotId: record.snapshotId } : {}),
          ...(typeof record.error === "string" ? { error: record.error } : {}),
        },
      };
    },
  };
}

/**
 * Create the `code_execute` tool for chaining tool calls.
 *
 * Code may call any tool the user's policy permits, including tools with side
 * effects; each individual call is authorized separately by `McpPolicy` and a
 * write pauses the script for confirmation rather than being refused up front.
 */
export function createCodeExecuteTool(manager: CodeModeManager) {
  return {
    name: "code_execute",
    label: "Code Execute",
    description:
      "Execute JavaScript that chains MCP tool calls for computation over their results — aggregate, filter, loop, join, paginate. Call tools with `await codemode.call('server/tool', args)`; use code_search or `codemode.describe` first to get exact parameters. Each tool call is authorized individually. Runs in a sandbox — no filesystem, network, or Node.js API access.",
    parameters: CodeInput,

    async execute(
      _toolCallId: string,
      params: CodeInputType,
      signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<CodeModeToolDetails>> {
      const start = performance.now();
      const result = await manager.executeCode(params.code, signal, params.snapshotId);
      return formatResult(result, Math.round(performance.now() - start), "Code execution error");
    },
  };
}
