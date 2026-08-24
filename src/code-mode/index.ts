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
      "## Code mode",
      "",
      "`code_execute` runs vanilla JavaScript in a sandboxed V8 isolate. Use it for:",
      "",
      "1. **Arbitrary computation** — math, string manipulation, date arithmetic, data transformation,",
      "   or any calculation the user asks for. No MCP tools needed; plain JS works.",
      "2. **Multi-tool aggregation** — counting, filtering, trending, or transforming results across",
      "   many tool calls. Write a loop inside one `code_execute` instead of making many separate tool calls.",
      "3. **Pagination** — fetch batches in a loop until exhausted, then compute over the full dataset.",
      "",
      "Use `code_search` first to discover what tools are available before writing execution code.",
      "",
      "**Code mode tools are always available — you do not need to call `load_skill` first.**",
      "",
      "### Choosing the right approach",
      "",
      "- **Skill** (`load_skill`) — a curated workflow exists for this domain task (e.g., a GitHub skill for PR management).",
      "- **tool-cli** — you need to discover what tools exist, or make a quick ad-hoc tool call.",
      "- **Code mode** (`code_execute`) — you need computation: math, aggregation, looping over results,",
      "  data transformation, or chaining multiple tool calls with logic in between.",
      "",
      "Pick based on what the task needs, not a fixed order. A calculation goes straight to code mode;",
      "a single lookup goes to a skill or tool-cli; exploration starts with tool-cli or `code_search`.",
      "",
      "**If unsure what's available**, start with `code_search` or `tool-cli --help` to see what you have.",
      "After producing a result, verify it makes sense — run a quick sanity check or spot-check values.",
      "",
      "### How to write code",
      "",
      "Write vanilla JavaScript (not TypeScript, not Node.js). No `require`, `import`, `fetch`,",
      "`fs`, `process`, or any Node.js/browser APIs. The only external API is the `codemode` namespace",
      "for MCP tool calls (optional — pure computation works without it). Always `return` the final result.",
      "",
      "**Write ONE `code_execute` call that does the whole job.** Loops, comparisons, pagination,",
      "and aggregation all happen inside a single execution.",
      "",
      "```javascript",
      "// Pure computation — no tools needed",
      "const factorial = (n) => n <= 1 ? 1 : n * factorial(n - 1);",
      "return { result: factorial(20), formatted: factorial(20).toLocaleString() };",
      "```",
      "",
      "```javascript",
      "// Aggregate across paginated MCP tool results",
      "const counts = {};",
      "let page = 1;",
      "while (true) {",
      "  const result = await codemode.list_items({ page, perPage: 100 });",
      "  for (const item of result.items) {",
      "    counts[item.category] = (counts[item.category] || 0) + 1;",
      "  }",
      "  if (result.items.length < 100) break;",
      "  page++;",
      "}",
      "return counts;",
      "```",
      "",
      "### Available tools",
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

    // Refresh eligible tools in case MCP servers changed since initialization
    this.refresh();

    const manager = this.mcpManager;
    const toolNames = this.eligibleTools.map((t) => t.name);

    const dispatch = async (toolName: string, args: Record<string, unknown>) => {
      const tool = this.eligibleTools.find((t) => t.name === toolName);
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found in code mode eligible tools`);
      }

      const terminal = await manager.callTool(tool.serverName, toolName, args);
      return terminal.result;
    };

    return executeInSandbox(code, toolNames, dispatch, {
      memoryLimit: this.options.memoryLimit,
      timeoutMs: this.options.timeoutMs,
    });
  }
}
