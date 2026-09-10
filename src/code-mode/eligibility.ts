import type { McpClientManager, McpTool } from "../mcp/index.js";
import { isReadOnlyToolCall } from "../mcp/policy.js";

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
  /**
   * The effect the server's annotations claim, as a closed classification.
   *
   * `runsUnattended` alone is lossy for anything that fingerprints it: an
   * ordinary write and a destructive one are both `false`, so a digest taken
   * over the boolean cannot see a tool acquiring `destructiveHint`. This field
   * exists so that distinction survives into the fingerprint.
   */
  readonly effect: CodeModeEffectClass;
  /** Normalized: deduplicated and in {@link APPROVAL_REASON_ORDER}. */
  readonly approvalReasons: readonly CodeModeApprovalReason[];
  readonly outputSchema?: NonNullable<McpTool["outputSchema"]>;
  readonly outputSchemaProvenance: OutputSchemaProvenance;
}

/** Why a Code Mode call pauses for human approval. */
export type CodeModeApprovalReason = "destructive_hint" | "not_annotated_read_only";

/**
 * Canonical order for {@link CodeModeApprovalReason}.
 *
 * Derivation order is an implementation detail; a fingerprint must not change
 * because two branches happened to push the same reasons in a different
 * sequence. Sorting against a fixed vocabulary makes the list a set with a
 * stable spelling.
 */
export const APPROVAL_REASON_ORDER: readonly CodeModeApprovalReason[] = Object.freeze([
  "not_annotated_read_only",
  "destructive_hint",
]);

/**
 * The approval posture a tool's annotations produce.
 *
 * Four cases, not two, because the classification has to be injective on
 * posture for a digest over it to mean anything:
 *
 * - `read_only` — annotated read-only and not destructive. Runs unattended.
 * - `write` — no read-only annotation. Pauses for approval.
 * - `destructive` — declared destructive. Pauses, and the prompt should say so.
 * - `contradictory_annotations` — claims read-only *and* destructive.
 *
 * The last is kept separate rather than folded into `destructive` on purpose.
 * A server that contradicts itself is a signal worth surfacing, and collapsing
 * the two would mean a tool losing its `readOnlyHint` while already destructive
 * produced no change in the fingerprint — which is precisely the transition an
 * approval-posture fingerprint exists to catch.
 */
export type CodeModeEffectClass =
  "read_only" | "write" | "destructive" | "contradictory_annotations";

/**
 * The fingerprintable approval posture of a single tool.
 *
 * Deliberately closed: every field is drawn from a fixed vocabulary, so this
 * carries no server-controlled free text into a digest and cannot be used to
 * smuggle bytes past a delimiter.
 */
export interface CodeModeApprovalPosture {
  readonly effect: CodeModeEffectClass;
  readonly runsUnattended: boolean;
  readonly reasons: readonly CodeModeApprovalReason[];
}

/**
 * Version of the posture vocabulary itself.
 *
 * Included in the serialized form so that changing the classification — adding
 * a class, renaming a reason — invalidates existing snapshots instead of
 * silently colliding with them.
 */
export const APPROVAL_POSTURE_SCHEMA_VERSION = 1;

function classifyEffect(tool: McpTool): CodeModeEffectClass {
  const readOnly = tool.annotations?.readOnlyHint === true;
  const destructive = tool.annotations?.destructiveHint === true;
  if (readOnly && destructive) return "contradictory_annotations";
  if (destructive) return "destructive";
  if (readOnly) return "read_only";
  return "write";
}

function normalizeApprovalReasons(tool: McpTool): CodeModeApprovalReason[] {
  const reasons = new Set<CodeModeApprovalReason>();
  if (tool.annotations?.readOnlyHint !== true) reasons.add("not_annotated_read_only");
  if (tool.annotations?.destructiveHint === true) reasons.add("destructive_hint");
  return APPROVAL_REASON_ORDER.filter((reason) => reasons.has(reason));
}

/** Extract the fingerprintable approval posture from a tool or catalog entry. */
export function approvalPosture(tool: McpTool | CodeModeTool): CodeModeApprovalPosture {
  const source = "tool" in tool ? tool.tool : tool;
  return {
    effect: classifyEffect(source),
    runsUnattended: isReadOnlyToolCall(source),
    reasons: normalizeApprovalReasons(source),
  };
}

/**
 * Render a posture as a stable string for inclusion in a definition digest.
 *
 * Total, deterministic, and injective on posture. Safe to concatenate without
 * escaping because every component is a member of a closed enum — no server
 * string reaches this function.
 */
export function serializeApprovalPosture(posture: CodeModeApprovalPosture): string {
  const reasons = APPROVAL_REASON_ORDER.filter((reason) => posture.reasons.includes(reason));
  return [
    `v${String(APPROVAL_POSTURE_SCHEMA_VERSION)}`,
    posture.effect,
    posture.runsUnattended ? "unattended" : "approval_required",
    reasons.join(","),
  ].join(":");
}

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
 * Build the internal Code Mode catalog without mutating source MCP tool definitions.
 *
 * An output schema is synthesized for every tool, not just the unattended ones:
 * a write tool the model can call is a write tool it needs a return type for.
 */
export function toCodeModeTool(tool: McpTool): CodeModeTool {
  // Whether the call prompts is asked of the policy, never re-derived here.
  // This module used to carry its own copy of the read-only test, which is a
  // security classification expressed twice — two places to edit, one of them
  // easy to forget, and a divergence that would show up as the sandbox
  // silently skipping an approval the boundary intended to ask for.
  const posture = approvalPosture(tool);

  const declaredOutputSchema =
    tool.outputSchema !== undefined && tool.outputSchema !== null ? tool.outputSchema : undefined;

  return {
    tool,
    runsUnattended: posture.runsUnattended,
    effect: posture.effect,
    // Explanatory only: these say *why* the boundary will ask, for diagnostics
    // and type hints. They never decide it.
    approvalReasons: posture.reasons,
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
