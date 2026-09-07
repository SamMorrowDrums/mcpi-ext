import type { McpClientManager, McpTool } from "../mcp/index.js";

export const SYNTHESIZED_OUTPUT_SCHEMA = Object.freeze({}) as NonNullable<McpTool["outputSchema"]>;

export type OutputSchemaProvenance = "declared" | "synthesized" | "unavailable";
export type CodeModeRefusalReason = "destructive_hint" | "read_only_hint_required";

/**
 * Client-internal Code Mode metadata. The source MCP tool is retained separately
 * so provenance never becomes part of an MCP request or response.
 */
export interface CodeModeTool {
  readonly tool: McpTool;
  readonly callable: boolean;
  readonly refusalReasons: readonly CodeModeRefusalReason[];
  readonly outputSchema?: NonNullable<McpTool["outputSchema"]>;
  readonly outputSchemaProvenance: OutputSchemaProvenance;
}

export interface CodeModeDiagnostics {
  readonly totalTools: number;
  readonly callableTools: number;
  readonly refusedTools: number;
  readonly declaredOutputSchemas: number;
  readonly synthesizedOutputSchemas: number;
  readonly unavailableOutputSchemas: number;
}

/**
 * Code Mode dispatch is allowed only when a tool explicitly declares itself
 * read-only and does not also declare destructive behavior.
 */
export function isEligibleForCodeMode(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

/** Get all tools eligible for code mode across all connected MCP servers. */
export function getEligibleTools(mcpManager: McpClientManager): McpTool[] {
  return mcpManager.getTools().filter(isEligibleForCodeMode);
}

/** Build the internal Code Mode catalog without mutating source MCP tool definitions. */
export function toCodeModeTool(tool: McpTool): CodeModeTool {
  const refusalReasons: CodeModeRefusalReason[] = [];
  if (tool.annotations?.readOnlyHint !== true) {
    refusalReasons.push("read_only_hint_required");
  }
  if (tool.annotations?.destructiveHint === true) {
    refusalReasons.push("destructive_hint");
  }

  const callable = refusalReasons.length === 0;
  const declaredOutputSchema =
    tool.outputSchema !== undefined && tool.outputSchema !== null ? tool.outputSchema : undefined;

  if (declaredOutputSchema) {
    return {
      tool,
      callable,
      refusalReasons,
      outputSchema: declaredOutputSchema,
      outputSchemaProvenance: "declared",
    };
  }

  if (callable) {
    return {
      tool,
      callable,
      refusalReasons,
      outputSchema: SYNTHESIZED_OUTPUT_SCHEMA,
      outputSchemaProvenance: "synthesized",
    };
  }

  return {
    tool,
    callable,
    refusalReasons,
    outputSchemaProvenance: "unavailable",
  };
}

/** Get every discovered MCP tool with Code Mode permission and schema metadata. */
export function getCodeModeTools(mcpManager: McpClientManager): CodeModeTool[] {
  return mcpManager.getTools().map(toCodeModeTool);
}

export function getCodeModeDiagnostics(tools: readonly CodeModeTool[]): CodeModeDiagnostics {
  const callableTools = tools.filter((tool) => tool.callable).length;
  const countProvenance = (provenance: OutputSchemaProvenance) =>
    tools.filter((tool) => tool.outputSchemaProvenance === provenance).length;

  return {
    totalTools: tools.length,
    callableTools,
    refusedTools: tools.length - callableTools,
    declaredOutputSchemas: countProvenance("declared"),
    synthesizedOutputSchemas: countProvenance("synthesized"),
    unavailableOutputSchemas: countProvenance("unavailable"),
  };
}
