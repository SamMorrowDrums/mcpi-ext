import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicyError, type McpPolicy } from "../mcp/policy.js";
import {
  getCodeModeDiagnostics,
  getCodeModeTools,
  type CodeModeDiagnostics,
  type CodeModeTool,
} from "./eligibility.js";
import type { ExecuteResult, ExecutorOptions } from "./executor.js";
import { CodeModeDispatchError, executeInSandbox, type CodeModeErrorDetails } from "./executor.js";
import { loadIsolatedVm } from "./isolated-vm.js";
import { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
import { generateTypeHints } from "./type-hints.js";

export {
  SYNTHESIZED_OUTPUT_SCHEMA,
  getCodeModeDiagnostics,
  getCodeModeTools,
  toCodeModeTool,
} from "./eligibility.js";
export type {
  CodeModeApprovalReason,
  CodeModeDiagnostics,
  CodeModeTool,
  OutputSchemaProvenance,
} from "./eligibility.js";
export type { CodeModeErrorDetails, ExecuteResult, ExecutorOptions } from "./executor.js";
export { SANDBOX_UNAVAILABLE_ERROR, executeInSandbox, normalizeCode } from "./executor.js";
export {
  loadIsolatedVm,
  peekIsolatedVm,
  resetIsolatedVmCacheForTests,
  setIsolatedVmForTests,
  type IsolatedVmLoad,
  type IsolatedVmModule,
} from "./isolated-vm.js";
export { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
export { generateTypeHints, jsonSchemaToTypeString, sanitizeToolName } from "./type-hints.js";

export interface CodeModeManagerOptions extends ExecutorOptions {
  /** Log function for status messages. */
  log?: (msg: string) => void;
  /** Test seam for proving pre-isolate refusals. */
  sandboxExecutor?: typeof executeInSandbox;
}

const NO_TOOLS_ERROR: CodeModeErrorDetails = {
  error: "no_tools",
  message: "code_search has no discovered MCP tools to search.",
  alternatives: ["code_execute", "tool-cli"],
};

/**
 * Whether the sandbox backend can run code.
 *
 * `unknown` is a real state, not a synonym for unavailable: before the optional
 * native addon has been probed we have not established anything, and reporting
 * that honestly is better than guessing in either direction.
 */
export interface SandboxAvailability {
  readonly state: "available" | "unavailable" | "unknown";
  readonly reason: string;
}

const SANDBOX_UNPROBED: SandboxAvailability = {
  state: "unknown",
  reason: "the isolated-vm native addon has not been probed yet",
};

const SANDBOX_INJECTED: SandboxAvailability = {
  state: "available",
  reason: "a sandbox executor was supplied directly, bypassing the isolated-vm addon",
};

const SANDBOX_NATIVE: SandboxAvailability = {
  state: "available",
  reason: "the isolated-vm native addon loaded",
};

/**
 * Orchestrates code mode: catalogs tools, generates type hints,
 * and executes model-generated code in a sandbox with tool dispatch.
 */
export class CodeModeManager {
  private mcpManager: McpClientManager | null = null;
  private policy: McpPolicy | null = null;
  private codeModeTools: CodeModeTool[] = [];
  private diagnostics: CodeModeDiagnostics = getCodeModeDiagnostics([]);
  private typeHints = generateTypeHints([]);
  private readonly options: CodeModeManagerOptions;
  private readonly sandboxExecutor: typeof executeInSandbox;
  private log: ((msg: string) => void) | undefined;
  private lastDiagnosticSummary = "";
  private sandbox: SandboxAvailability;
  private sandboxProbe: Promise<SandboxAvailability> | undefined;

  constructor(options: CodeModeManagerOptions = {}) {
    this.options = options;
    this.sandboxExecutor = options.sandboxExecutor ?? executeInSandbox;
    this.log = options.log;
    // An injected executor is the sandbox. Probing the native addon in that
    // case would report on a backend this manager will never call.
    this.sandbox = options.sandboxExecutor ? SANDBOX_INJECTED : SANDBOX_UNPROBED;
  }

  /**
   * Whether code mode should be advertised to the model.
   *
   * Only a *proven* unavailable sandbox switches this off. An unprobed backend
   * stays active because `code_execute` is registered synchronously at load and
   * returns a structured `sandbox_unavailable` error if it turns out it cannot
   * run — a truthful refusal at call time beats hiding a facility that works.
   */
  get isActive(): boolean {
    return this.sandbox.state !== "unavailable";
  }

  /** Current sandbox backend availability, without triggering a probe. */
  getSandboxAvailability(): SandboxAvailability {
    return this.sandbox;
  }

  /**
   * Load the optional native addon once and cache the verdict.
   *
   * Safe to call from any lifecycle hook; concurrent callers share one probe.
   */
  async probeSandbox(): Promise<SandboxAvailability> {
    if (this.sandbox.state !== "unknown") return this.sandbox;
    this.sandboxProbe ??= loadIsolatedVm().then((load) => {
      this.sandbox = load.available
        ? SANDBOX_NATIVE
        : { state: "unavailable", reason: load.reason };
      if (!load.available) {
        this.log?.(
          `[code-mode] disabled: ${load.reason}. Skills, tool-cli, and routing are unaffected.`,
        );
      }
      return this.sandbox;
    });
    return this.sandboxProbe;
  }

  /** Initialize with MCP manager and policy, catalog tools, and generate type hints. */
  initialize(mcpManager: McpClientManager, policy: McpPolicy, log?: (msg: string) => void): void {
    this.mcpManager = mcpManager;
    this.policy = policy;
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
      `${this.diagnostics.unattendedTools} unattended, ${this.diagnostics.approvalGatedTools} approval-gated; ` +
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

  /** Tools that dispatch from the sandbox without a human approval prompt. */
  getUnattendedTools(): McpTool[] {
    return this.codeModeTools.filter((entry) => entry.runsUnattended).map((entry) => entry.tool);
  }

  /** Get the complete client-internal catalog, including approval and schema provenance. */
  getCatalogTools(): readonly CodeModeTool[] {
    return this.codeModeTools;
  }

  getDiagnostics(): CodeModeDiagnostics {
    return this.diagnostics;
  }

  /** Execute code in search mode (tool catalog queries). */
  async searchTools(code: string): Promise<ExecuteResult> {
    this.refresh();
    if (this.diagnostics.totalTools === 0) {
      return {
        result: undefined,
        error: NO_TOOLS_ERROR.message,
        errorDetails: {
          ...NO_TOOLS_ERROR,
          alternatives: [...(NO_TOOLS_ERROR.alternatives ?? [])],
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
      "Use when a task needs exact computation or control flow: math, aggregation, looping over",
      "results, data transformation, or chaining several MCP tool calls with logic in between.",
      "",
      "`code_execute` runs vanilla JavaScript in a sandboxed V8 isolate. Concretely, that covers:",
      "",
      "1. **Arbitrary computation** — math, string manipulation, date arithmetic, data transformation,",
      "   or any calculation the user asks for. No MCP tools needed; plain JS works.",
      "2. **Multi-tool aggregation** — counting, filtering, trending, or transforming results across",
      "   many tool calls. Write a loop inside one `code_execute` instead of making many separate tool calls.",
      "3. **Pagination** — fetch batches in a loop until exhausted, then compute over the full dataset.",
      "",
      "Use `code_search` first to discover which MCP tools are reachable from inside the sandbox.",
      "",
      "`code_search` and `code_execute` are always registered and never gated.",
      "",
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
    const policy = this.policy;
    const toolNames = this.codeModeTools.map((entry) => entry.tool.name);

    const dispatch = async (toolName: string, args: Record<string, unknown>) => {
      const codeModeTool = this.codeModeTools.find((entry) => entry.tool.name === toolName);
      if (!codeModeTool) {
        throw new Error(`Tool "${toolName}" not found in the code mode tool catalog`);
      }

      if (!policy) {
        throw new Error("Code mode MCP policy is not initialized");
      }

      try {
        // The sandbox never reaches a server itself. The call is made here, in
        // the harness, which is what makes a mid-script approval prompt
        // possible at all: the script awaits while the user decides.
        const terminal = await policy.callTool({
          source: "code-mode",
          serverName: codeModeTool.tool.serverName,
          toolName: codeModeTool.tool.name,
          args,
        });
        return terminal.result;
      } catch (error) {
        throw toCodeModeDispatchError(error, codeModeTool);
      }
    };

    return this.sandboxExecutor(code, toolNames, dispatch, {
      memoryLimit: this.options.memoryLimit,
      timeoutMs: this.options.timeoutMs,
    });
  }
}

/**
 * Translate a policy denial into Code Mode's structured dispatch error.
 *
 * A declined approval is the interesting case: the script asked to do something
 * the user said no to, so the error names the annotations that made it ask,
 * rather than implying the tool was never reachable.
 */
function toCodeModeDispatchError(error: unknown, codeModeTool: CodeModeTool): unknown {
  if (!(error instanceof McpPolicyError)) return error;

  const approvalRefused =
    error.reason === "approval_declined" || error.reason === "approval_unavailable";
  return new CodeModeDispatchError({
    error: error.reason,
    message: error.message,
    alternatives: [...error.alternatives],
    toolName: codeModeTool.tool.name,
    ...(approvalRefused ? { reason: formatApprovalReasons(codeModeTool) } : {}),
  });
}

function formatApprovalReasons(codeModeTool: CodeModeTool): string {
  return codeModeTool.approvalReasons
    .map((reason) =>
      reason === "destructive_hint"
        ? "annotations.destructiveHint is true"
        : "annotations.readOnlyHint is not true",
    )
    .join("; ");
}
