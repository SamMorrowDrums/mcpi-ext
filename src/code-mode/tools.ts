import type { AgentToolResult, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { CodeModeManager } from "./index.js";

const CodeInput = Type.Object({
  code: Type.String({
    description:
      "JavaScript code to execute. Use the `codemode` namespace to call tools (e.g. `codemode.search_docs({ query: 'test' })`). Code runs in a sandbox with no access to filesystem, network, or Node.js APIs.",
  }),
});

type CodeInputType = Static<typeof CodeInput>;

export interface CodeModeToolDetails {
  executionMs: number;
  logs: string[];
  error?: string;
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
      "Search the available read-only MCP tool catalog by writing JavaScript. Use `codemode.listTools()` to list tools and `codemode.describeTools(names)` for type info.",
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
      const executionMs = Math.round(performance.now() - start);

      if (result.error) {
        return {
          content: [{ type: "text", text: `Code search error: ${result.error}` }],
          details: { executionMs, logs: result.logs, error: result.error },
        };
      }

      const output =
        typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
      const logsSection = result.logs.length > 0 ? `\n\nLogs:\n${result.logs.join("\n")}` : "";

      return {
        content: [{ type: "text", text: output + logsSection }],
        details: { executionMs, logs: result.logs },
      };
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
      "Execute JavaScript that chains read-only MCP tool calls. Access tools via `codemode.toolName(args)`. Code runs in a sandbox — no filesystem, network, or Node.js API access.",
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
      const executionMs = Math.round(performance.now() - start);

      if (result.error) {
        return {
          content: [{ type: "text", text: `Code execution error: ${result.error}` }],
          details: { executionMs, logs: result.logs, error: result.error },
        };
      }

      const output =
        typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2);
      const logsSection = result.logs.length > 0 ? `\n\nLogs:\n${result.logs.join("\n")}` : "";

      return {
        content: [{ type: "text", text: output + logsSection }],
        details: { executionMs, logs: result.logs },
      };
    },
  };
}
