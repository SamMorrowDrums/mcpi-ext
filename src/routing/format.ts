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
export const TASK_SHAPE_SELECTION_TAG = "task_shape_selection";

const PREAMBLE: readonly string[] = [
  "Treat an unavailable facility as absent: do not invoke it or claim output from it.",
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

  lines.push(`</${EXECUTION_ROUTING_TAG}>`);

  return lines.join("\n");
}

/**
 * Final routing instruction, appended after every mechanism-specific section.
 *
 * Keeping selection here prevents later syntax examples from outweighing the
 * task-shape rule while preserving composition rather than global precedence.
 */
export function formatTaskShapeSelectionFooter(): string {
  return `

<${TASK_SHAPE_SELECTION_TAG}>
## Task-shape selection

- Standalone MCP lookup: provider-native deferred search, then direct proxy. Do not open bash/tool-cli or Code Mode merely for that call.
- Computed multi-call work: use Code Mode.
- Genuine shell, file, or external-program artifact pipeline: use bash + tool-cli (for example, Pandoc).
- Skill workflow: load the skill; use revealed direct tools for straightforward steps and Code Mode only for needed computation or control flow.

No universal precedence. Treat unavailable facilities as absent.
</${TASK_SHAPE_SELECTION_TAG}>`;
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
