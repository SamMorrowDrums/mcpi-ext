import type { McpClientManager, McpTool } from "../mcp/index.js";
import { getEligibleTools } from "./eligibility.js";
import type { ExecuteResult, ExecutorOptions } from "./executor.js";
import { executeInSandbox } from "./executor.js";
import { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
import { generateTypeHints } from "./type-hints.js";

export { getEligibleTools, isEligibleForCodeMode } from "./eligibility.js";
export type { ExecuteResult, ExecutorOptions } from "./executor.js";
export { executeInSandbox, normalizeCode } from "./executor.js";
export { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
export { generateTypeHints, jsonSchemaToTypeString, sanitizeToolName } from "./type-hints.js";

export interface CodeModeManagerOptions extends ExecutorOptions {
  /** Log function for status messages. */
  log?: (msg: string) => void;
}

/**
 * Orchestrates code mode: discovers eligible tools, generates type hints,
 * and executes model-generated code in a sandbox with tool dispatch.
 */
export class CodeModeManager {
  private mcpManager: McpClientManager | null = null;
  private eligibleTools: McpTool[] = [];
  private typeHints = "";
  private options: CodeModeManagerOptions;

  constructor(options: CodeModeManagerOptions = {}) {
    this.options = options;
  }

  /** Initialize with MCP manager, discover eligible tools, generate type hints. */
  initialize(mcpManager: McpClientManager): void {
    this.mcpManager = mcpManager;
    this.refresh();
  }

  /** Refresh eligible tools and type hints (call on tools/list_changed). */
  refresh(): void {
    if (!this.mcpManager) return;
    this.eligibleTools = getEligibleTools(this.mcpManager);
    this.typeHints = generateTypeHints(this.eligibleTools);
    this.options.log?.(
      `[code-mode] ${this.eligibleTools.length} eligible tool(s), ${this.typeHints.length} chars of type hints`,
    );
  }

  /** Get the type hints string for injection into system prompt. */
  getTypeHints(): string {
    return this.typeHints;
  }

  /** Get eligible tools. */
  getEligibleTools(): McpTool[] {
    return this.eligibleTools;
  }

  /** Whether code mode has any eligible tools. */
  get isActive(): boolean {
    return this.eligibleTools.length > 0;
  }

  /** Execute code in search mode (tool catalog queries). */
  async searchTools(code: string): Promise<ExecuteResult> {
    return this.execute(code);
  }

  /** Execute code that chains MCP tool calls. */
  async executeCode(code: string): Promise<ExecuteResult> {
    return this.execute(code);
  }

  /** Create the Pi tool definitions for code_search and code_execute. */
  createTools() {
    return {
      codeSearch: createCodeSearchTool(this),
      codeExecute: createCodeExecuteTool(this),
    };
  }

  /** Format a system prompt section for code mode. */
  formatSystemPromptSection(): string {
    if (!this.isActive) return "";

    return [
      "",
      "<code_mode>",
      "## When to use code mode",
      "",
      "**Prefer code mode over direct tool calls** for tasks requiring aggregation, analysis,",
      "filtering, counting, or transformation across multiple items or timeframes.",
      "Think of the available tools as data sources and write code to compute over them.",
      "",
      "Use `code_search` to discover what tools are available before writing execution code.",
      "",
      "**Use code mode for:**",
      "- Counting or filtering items over specific criteria (state, labels, dates)",
      "- Calculating trends or summaries over time (e.g., issues per week, open/close ratios)",
      "- Extracting unique values, top contributors, or other aggregations",
      "- Any task that would otherwise require many consecutive tool calls",
      "",
      "**Use direct tool calls for:** single lookups with no computation needed.",
      "",
      "**Note:** Code mode tools are already available — you do not need to call `load_skill` first.",
      "",
      "## How to write code mode executions",
      "",
      "Write vanilla JavaScript (not TypeScript, not Node.js). The code runs in a sandboxed V8 isolate.",
      "There is no `require`, `import`, `fetch`, `fs`, `process`, or any Node.js/browser APIs.",
      "The only available API is the `codemode` namespace. Always `return` your final result.",
      "",
      "**Write ONE `code_execute` call that does the whole job.** Loops, comparisons, pagination,",
      "and aggregation all happen inside a single execution. Do NOT make separate `code_execute` calls",
      "for each item — aggregate comprehensively in one execution.",
      "",
      "**Handle pagination:** Results from tools may be paged. Fetch batches in a loop until done.",
      "",
      "```javascript",
      "// Example: count issues by state over the last year",
      "const counts = { open: 0, closed: 0 };",
      "let page = 1;",
      "while (true) {",
      '  const result = await codemode.search_issues({ query: "author:me", page, perPage: 100 });',
      "  for (const issue of result.items) {",
      "    counts[issue.state]++;",
      "  }",
      "  if (result.items.length < 100) break;",
      "  page++;",
      "}",
      "return counts;",
      "```",
      "",
      "## Available tools",
      "",
      "```typescript",
      this.typeHints,
      "```",
      "</code_mode>",
    ].join("\n");
  }

  private async execute(code: string): Promise<ExecuteResult> {
    if (!this.mcpManager) {
      return { result: undefined, error: "Code mode not initialized", logs: [] };
    }

    const toolNames = this.eligibleTools.map((t) => t.name);

    const dispatch = async (toolName: string, args: Record<string, unknown>) => {
      const tool = this.eligibleTools.find((t) => t.name === toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found in code mode eligible tools`);
      }

      const client = this.mcpManager?.getClient(tool.serverName);
      if (!client) {
        throw new Error(`MCP server "${tool.serverName}" is not connected`);
      }

      const result = await client.callTool({ name: toolName, arguments: args });

      // Prefer structuredContent (typed output) over raw content
      if (result.structuredContent) {
        return result.structuredContent;
      }

      // Fall back to parsing text content
      if (Array.isArray(result.content)) {
        const textParts = result.content
          .filter(
            (c): c is { type: string; text: string } =>
              typeof c === "object" && c !== null && "text" in c,
          )
          .map((c) => c.text);

        const combined = textParts.join("\n");
        try {
          return JSON.parse(combined);
        } catch {
          return combined;
        }
      }

      return result;
    };

    return executeInSandbox(code, toolNames, dispatch, {
      memoryLimit: this.options.memoryLimit,
      timeoutMs: this.options.timeoutMs,
    });
  }
}
