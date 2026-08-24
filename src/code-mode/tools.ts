import type { AgentToolResult, ExtensionContext } from "@sammorrowdrums/mcpi";
import { Type, type Static } from "typebox";
import type { ExecuteResult } from "./executor.js";
import type { CodeModeManager } from "./index.js";

const CodeInput = Type.Object({
  code: Type.String({
    description:
      "JavaScript code to execute. Use the `codemode` namespace to call tools (e.g. `codemode.search_docs({ query: 'test' })`). Always `return` your final result. Code runs in a sandbox with no access to filesystem, network, or Node.js APIs.",
  }),
});

type CodeInputType = Static<typeof CodeInput>;

export interface CodeModeToolDetails {
  executionMs: number;
  logs: string[];
  error?: string;
  message?: string;
  alternatives?: string[];
  toolName?: string;
  reason?: string;
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
 * The model writes JavaScript to discover and filter available tools.
 * The sandbox provides `codemode.listTools()` and `codemode.describeTools(names)`.
 */
export function createCodeSearchTool(manager: CodeModeManager) {
  return {
    name: "code_search",
    label: "Code Search",
    description:
      "Discover all available MCP tools by writing JavaScript. Use `codemode.listTools()` to list tools and `codemode.describeTools(names)` for type info. Type hints identify which tools Code Mode can call; non-read-only tools remain discovery-only.",
    parameters: CodeInput,

    async execute(
      _toolCallId: string,
      params: CodeInputType,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<CodeModeToolDetails>> {
      const start = performance.now();
      const result = await manager.searchTools(params.code);
      return formatResult(result, Math.round(performance.now() - start), "Code search error");
    },
  };
}

/**
 * Create the `code_execute` tool for chaining tool calls.
 *
 * The model writes JavaScript that calls read-only MCP tools via
 * the `codemode` namespace (e.g. `codemode.search_docs({ query: 'test' })`).
 * Code runs in a sandbox with no access to filesystem, network, or Node.js APIs.
 */
export function createCodeExecuteTool(manager: CodeModeManager) {
  return {
    name: "code_execute",
    label: "Code Execute",
    description:
      "Execute JavaScript that chains read-only MCP tool calls for computation over data. Use when you need to aggregate, filter, loop, or transform results across multiple tool calls. Access tools via `codemode.toolName(args)`. Runs in a sandbox — no filesystem, network, or Node.js API access.",
    parameters: CodeInput,

    async execute(
      _toolCallId: string,
      params: CodeInputType,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<CodeModeToolDetails>> {
      const start = performance.now();
      const result = await manager.executeCode(params.code);
      return formatResult(result, Math.round(performance.now() - start), "Code execution error");
    },
  };
}
