import type { McpSkillMetadata } from "./skill-registry.js";

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Format MCP-discovered skills for inclusion in the system prompt.
 *
 * Produces XML matching Pi's native `formatSkillsForPrompt` structure,
 * but references the `load_skill` tool instead of `read` and uses
 * `mcp:<serverName>` as the location.
 *
 * This is the catalogue of what exists. Which kind of task suits a skill at all
 * is decided by the `<execution_routing>` section, which reports skill
 * availability whether or not any were discovered.
 */
export function formatMcpSkillsForPrompt(skills: McpSkillMetadata[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "",
    "",
    "Use when a task matches one of the domain workflows these MCP skills document — that is,",
    "when the server's own procedure is what you need, not merely when its tools would be useful.",
    "Call load_skill with the skill's name to read its instructions before working through it.",
    "load_skill returns the skill body and reveals the full schemas of the tool definitions it",
    "references. It asks you nothing and authorizes nothing: the tools a skill names were already",
    "dispatchable, and the ones it omits still are. Approval, where a tool needs it, happens when",
    "that tool runs.",
    "",
    "<available_mcp_skills>",
  ];

  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <server>${escapeXml(skill.serverName)}</server>`);
    lines.push("  </skill>");
  }

  lines.push("</available_mcp_skills>");
  return lines.join("\n");
}
