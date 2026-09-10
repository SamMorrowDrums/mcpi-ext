import {
  buildExecutionFacilities,
  type ExecutionFacility,
  type ExecutionRoutingState,
} from "./facilities.js";

/**
 * Tag for the routing section. Named `execution_routing` rather than anything
 * that reads like an invocable surface, so the model never mistakes the section
 * itself for something it can call.
 */
export const EXECUTION_ROUTING_TAG = "execution_routing";

const PREAMBLE: readonly string[] = [
  "Choose among these facilities by task shape, not rank; none is a default.",
  "",
  "For one straightforward MCP call, provider-native deferred search plus a direct proxy fits when available.",
  "",
  "Treat an unavailable facility as absent: do not invoke it or claim output from it.",
];

const COMPOSITION: readonly string[] = [
  "### Composing facilities",
  "",
  "Run tool-cli inside bash for shell, file, or artifact pipelines such as Pandoc. Use Code mode for",
  "multi-call exact arithmetic, filtering, aggregation, joins, or reduction. Facilities may compose;",
  "this is task-shape guidance, not precedence.",
];

function formatFacility(facility: ExecutionFacility): string[] {
  const lines: string[] = [`### ${facility.title}`, "", facility.useWhen, "", "Provides:"];

  for (const item of facility.provides) {
    lines.push(`- ${item}`);
  }

  lines.push("", "Does not provide:");
  for (const item of facility.doesNotProvide) {
    lines.push(`- ${item}`);
  }

  lines.push("", `Availability: ${facility.availability.state} — ${facility.availability.detail}`);
  return lines;
}

/**
 * Render an already-built facility list.
 *
 * Kept separate from {@link formatExecutionRouting} so the future host seam and
 * the prompt fallback can render byte-identical text from one descriptor list.
 */
export function formatExecutionFacilities(facilities: readonly ExecutionFacility[]): string {
  const lines: string[] = ["", "", `<${EXECUTION_ROUTING_TAG}>`, "## Execution routing", ""];

  lines.push(...PREAMBLE, "");

  for (const facility of facilities) {
    lines.push(...formatFacility(facility), "");
  }

  lines.push(...COMPOSITION);
  lines.push(`</${EXECUTION_ROUTING_TAG}>`);

  return lines.join("\n");
}

/**
 * Render the execution routing section for the current session.
 *
 * Emitted whenever mcpi-ext loads, including with zero MCP servers connected —
 * an agent still needs to know that exact computation and the shell are on the
 * table, and why the MCP-backed facilities are not.
 *
 * Deterministic: equal state always produces byte-identical output.
 */
export function formatExecutionRouting(state: ExecutionRoutingState): string {
  return formatExecutionFacilities(buildExecutionFacilities(state));
}
