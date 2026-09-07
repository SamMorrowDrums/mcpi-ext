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
  "This session exposes four execution facilities. They differ by the *shape* of the work, not by",
  "rank: none of them is a default, none outranks another, and there is no sequence to try them in.",
  "Match the facility to what the task actually requires.",
  "",
  "Every facility below states its own availability. Treat an unavailable facility as absent for",
  "this session: do not invoke it, and never describe or summarise output it did not produce.",
];

const COMPOSITION: readonly string[] = [
  "### Composing facilities",
  "",
  "One task may need more than one facility. tool-cli and bash compose especially closely: tool-cli",
  "*is* a program you run with the bash tool, so fetching MCP data and then filtering, joining, or",
  "writing it to disk with ordinary shell programs is a single bash command rather than two rival",
  "approaches. Code mode composes by handing you an exact value you then act on elsewhere, and a",
  "skill composes by telling you which tools its workflow expects you to use.",
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
