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
 */
export function formatMcpSkillsForPrompt(skills: McpSkillMetadata[]): string {
  if (skills.length === 0) return "";

  const lines = [
    "",
    "",
    "The following MCP skills provide specialized instructions and tools for specific tasks.",
    "MCP tools are deferred — they are available but not described in this prompt.",
    "You MUST call load_skill to discover tool definitions and get usage instructions.",
    "The load_skill result will include tool schemas so you know how to call them.",
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
