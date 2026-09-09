import type { McpClientManager, McpTool } from "../mcp/index.js";

export const SYNTHESIZED_OUTPUT_SCHEMA = Object.freeze({}) as NonNullable<McpTool["outputSchema"]>;

export type OutputSchemaProvenance = "declared" | "synthesized" | "unavailable";

/**
 * Client-internal Code Mode metadata. The source MCP tool is retained separately
 * so provenance never becomes part of an MCP request or response.
 */
export interface CodeModeTool {
  readonly tool: McpTool;
  /**
   * Whether a call from inside the sandbox runs without asking the user.
   *
   * Every discovered tool is dispatchable from Code Mode. This flag only
   * distinguishes the tools the server annotated read-only, which run
   * unattended, from the ones that pause at a human approval prompt mid-script.
   */
  readonly runsUnattended: boolean;
  readonly approvalReasons: readonly CodeModeApprovalReason[];
  readonly outputSchema?: NonNullable<McpTool["outputSchema"]>;
  readonly outputSchemaProvenance: OutputSchemaProvenance;
}

/** Why a Code Mode call pauses for human approval. */
export type CodeModeApprovalReason = "destructive_hint" | "not_annotated_read_only";

export interface CodeModeDiagnostics {
  readonly totalTools: number;
  /** Tools that dispatch without a prompt because the server annotated them read-only. */
  readonly unattendedTools: number;
  /** Tools that dispatch only after the user approves the call. */
  readonly approvalGatedTools: number;
  readonly declaredOutputSchemas: number;
  readonly synthesizedOutputSchemas: number;
  readonly unavailableOutputSchemas: number;
}

/**
 * Whether a Code Mode call dispatches without a human approval prompt.
 *
 * This is not an eligibility test. A tool that fails it is still callable from
 * inside the sandbox — it simply pauses at the host approval prompt first,
 * which is exactly the mid-script "are you sure?" that routing MCP calls back
 * through the harness is what buys.
 */
export function runsUnattendedInCodeMode(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

/** Get all tools that dispatch from Code Mode without prompting, across all servers. */
export function getUnattendedTools(mcpManager: McpClientManager): McpTool[] {
  return mcpManager.getTools().filter(runsUnattendedInCodeMode);
}

/**
 * Build the internal Code Mode catalog without mutating source MCP tool definitions.
 *
 * An output schema is synthesized for every tool, not just the unattended ones:
 * a write tool the model can call is a write tool it needs a return type for.
 */
export function toCodeModeTool(tool: McpTool): CodeModeTool {
  const approvalReasons: CodeModeApprovalReason[] = [];
  if (tool.annotations?.readOnlyHint !== true) {
    approvalReasons.push("not_annotated_read_only");
  }
  if (tool.annotations?.destructiveHint === true) {
    approvalReasons.push("destructive_hint");
  }

  const runsUnattended = approvalReasons.length === 0;
  const declaredOutputSchema =
    tool.outputSchema !== undefined && tool.outputSchema !== null ? tool.outputSchema : undefined;

  return {
    tool,
    runsUnattended,
    approvalReasons,
    outputSchema: declaredOutputSchema ?? SYNTHESIZED_OUTPUT_SCHEMA,
    outputSchemaProvenance: declaredOutputSchema ? "declared" : "synthesized",
  };
}

/** Get every discovered MCP tool with Code Mode approval and schema metadata. */
export function getCodeModeTools(mcpManager: McpClientManager): CodeModeTool[] {
  return mcpManager.getTools().map(toCodeModeTool);
}

export function getCodeModeDiagnostics(tools: readonly CodeModeTool[]): CodeModeDiagnostics {
  const unattendedTools = tools.filter((tool) => tool.runsUnattended).length;
  const countProvenance = (provenance: OutputSchemaProvenance) =>
    tools.filter((tool) => tool.outputSchemaProvenance === provenance).length;

  return {
    totalTools: tools.length,
    unattendedTools,
    approvalGatedTools: tools.length - unattendedTools,
    declaredOutputSchemas: countProvenance("declared"),
    synthesizedOutputSchemas: countProvenance("synthesized"),
    unavailableOutputSchemas: countProvenance("unavailable"),
  };
}
