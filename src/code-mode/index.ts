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
      "You have access to code mode tools (`code_search` and `code_execute`) for autonomous read-only MCP tool usage.",
      "Write JavaScript using the `codemode` namespace to call tools. Code runs in a sandbox.",
      "",
      "Type hints for available tools:",
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
