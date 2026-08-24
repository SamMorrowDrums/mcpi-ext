import type { McpClientManager, McpTool } from "../mcp/index.js";
import {
  getCodeModeDiagnostics,
  getCodeModeTools,
  type CodeModeDiagnostics,
  type CodeModeTool,
} from "./eligibility.js";
import type { ExecuteResult, ExecutorOptions } from "./executor.js";
import { CodeModeDispatchError, executeInSandbox, type CodeModeErrorDetails } from "./executor.js";
import { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
import { generateTypeHints } from "./type-hints.js";

export {
  SYNTHESIZED_OUTPUT_SCHEMA,
  getCodeModeDiagnostics,
  getCodeModeTools,
  getEligibleTools,
  isEligibleForCodeMode,
  toCodeModeTool,
} from "./eligibility.js";
export type {
  CodeModeDiagnostics,
  CodeModeRefusalReason,
  CodeModeTool,
  OutputSchemaProvenance,
} from "./eligibility.js";
export type { CodeModeErrorDetails, ExecuteResult, ExecutorOptions } from "./executor.js";
export { executeInSandbox, normalizeCode } from "./executor.js";
export { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
export { generateTypeHints, jsonSchemaToTypeString, sanitizeToolName } from "./type-hints.js";

export interface CodeModeManagerOptions extends ExecutorOptions {
  /** Log function for status messages. */
  log?: (msg: string) => void;
  /** Test seam for proving pre-isolate refusals. */
  sandboxExecutor?: typeof executeInSandbox;
}

const NO_ELIGIBLE_TOOLS_ERROR: CodeModeErrorDetails = {
  error: "no_eligible_tools",
  message: "code_search has no callable read-only MCP tools to search.",
  alternatives: ["code_execute", "tool-cli"],
};

/**
 * Orchestrates code mode: catalogs tools, generates type hints,
 * and executes model-generated code in a sandbox with tool dispatch.
 */
export class CodeModeManager {
  private mcpManager: McpClientManager | null = null;
  private codeModeTools: CodeModeTool[] = [];
  private diagnostics: CodeModeDiagnostics = getCodeModeDiagnostics([]);
  private typeHints = generateTypeHints([]);
  private readonly options: CodeModeManagerOptions;
  private readonly sandboxExecutor: typeof executeInSandbox;
  private log: ((msg: string) => void) | undefined;
  private lastDiagnosticSummary = "";
  readonly isActive = true;

  constructor(options: CodeModeManagerOptions = {}) {
    this.options = options;
    this.sandboxExecutor = options.sandboxExecutor ?? executeInSandbox;
    this.log = options.log;
  }

  /** Initialize with MCP manager, catalog tools, and generate type hints. */
  initialize(mcpManager: McpClientManager, log?: (msg: string) => void): void {
    this.mcpManager = mcpManager;
    this.log = log ?? this.log;
    this.refresh();
  }

  /** Refresh the complete tool catalog and type hints (call on tools/list_changed). */
  refresh(): void {
    this.codeModeTools = this.mcpManager ? getCodeModeTools(this.mcpManager) : [];
    this.diagnostics = getCodeModeDiagnostics(this.codeModeTools);
    this.typeHints = generateTypeHints(this.codeModeTools);

    const summary =
      `[code-mode] ${this.diagnostics.totalTools} tool(s): ` +
      `${this.diagnostics.callableTools} callable, ${this.diagnostics.refusedTools} dispatch-refused; ` +
      `output schemas: ${this.diagnostics.declaredOutputSchemas} declared, ` +
      `${this.diagnostics.synthesizedOutputSchemas} synthesized, ` +
      `${this.diagnostics.unavailableOutputSchemas} unavailable; ` +
      `${this.typeHints.length} chars of type hints`;
    if (summary !== this.lastDiagnosticSummary) {
      this.log?.(summary);
      this.lastDiagnosticSummary = summary;
    }
  }

  /** Get the type hints string for injection into system prompt. */
  getTypeHints(): string {
    return this.typeHints;
  }

  /** Get eligible tools. */
  getEligibleTools(): McpTool[] {
    return this.codeModeTools.filter((entry) => entry.callable).map((entry) => entry.tool);
  }

  /** Get the complete client-internal catalog, including permission and schema provenance. */
  getCatalogTools(): readonly CodeModeTool[] {
    return this.codeModeTools;
  }

  getDiagnostics(): CodeModeDiagnostics {
    return this.diagnostics;
  }

  /** Execute code in search mode (tool catalog queries). */
  async searchTools(code: string): Promise<ExecuteResult> {
    this.refresh();
    if (this.diagnostics.callableTools === 0) {
      return {
        result: undefined,
        error: NO_ELIGIBLE_TOOLS_ERROR.message,
        errorDetails: {
          ...NO_ELIGIBLE_TOOLS_ERROR,
          alternatives: [...(NO_ELIGIBLE_TOOLS_ERROR.alternatives ?? [])],
        },
        logs: [],
      };
    }
    return this.execute(code);
  }

  /** Execute code that chains MCP tool calls. */
  async executeCode(code: string): Promise<ExecuteResult> {
    this.refresh();
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
    const manager = this.mcpManager;
    const toolNames = this.codeModeTools.map((entry) => entry.tool.name);

    const dispatch = async (toolName: string, args: Record<string, unknown>) => {
      const codeModeTool = this.codeModeTools.find((entry) => entry.tool.name === toolName);
      if (!codeModeTool) {
        throw new Error(`Tool "${toolName}" not found in code mode eligible tools`);
      }

      if (!codeModeTool.callable) {
        throw new CodeModeDispatchError({
          error: "permission_denied",
          message:
            `Tool "${toolName}" is visible for discovery but cannot be called from Code Mode. ` +
            "Use load_skill or tool-cli through the host's permission-aware path.",
          alternatives: ["load_skill", "tool-cli"],
          toolName,
          reason: formatRefusalReasons(codeModeTool),
        });
      }

      if (!manager) {
        throw new Error("Code mode MCP manager is not initialized");
      }

      const terminal = await manager.callTool(
        codeModeTool.tool.serverName,
        codeModeTool.tool.name,
        args,
      );
      return terminal.result;
    };

    return this.sandboxExecutor(code, toolNames, dispatch, {
      memoryLimit: this.options.memoryLimit,
      timeoutMs: this.options.timeoutMs,
    });
  }
}

function formatRefusalReasons(codeModeTool: CodeModeTool): string {
  return codeModeTool.refusalReasons
    .map((reason) =>
      reason === "destructive_hint"
        ? "annotations.destructiveHint is true"
        : "annotations.readOnlyHint is not true",
    )
    .join("; ");
}
