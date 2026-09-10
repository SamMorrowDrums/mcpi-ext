import { parseFrontmatter } from "../frontmatter.js";
import type { McpPolicy } from "../mcp/policy.js";
import type { McpSkillMetadata } from "./skill-registry.js";

/**
 * Discover skills from a connected MCP server by reading its resources.
 *
 * Looks for resources with `skill://` URIs ending in `/SKILL.md`,
 * reads each one, and parses YAML frontmatter for skill metadata.
 *
 * All resource I/O goes through the shared policy boundary, so a server can
 * only ever surface its own skill resources.
 */
export async function discoverSkillsFromServer(
  policy: McpPolicy,
  serverName: string,
  log: (msg: string) => void = console.error,
  signal?: AbortSignal,
): Promise<McpSkillMetadata[]> {
  const skills: McpSkillMetadata[] = [];

  let skillResources: { uri: string; name?: string }[];
  try {
    skillResources = await policy.listSkillResources(serverName, signal);
  } catch {
    log(
      `[skills] Server "${serverName}" does not support resources/list, skipping skill discovery`,
    );
    return skills;
  }

  if (skillResources.length === 0) return skills;

  for (const resource of skillResources) {
    try {
      const result = await policy.readResource({
        source: "skill-discovery",
        serverName,
        uri: resource.uri,
        ...(signal ? { signal } : {}),
      });
      const textContent = result.contents.find(
        (c): c is { uri: string; text: string } => "text" in c,
      );
      if (!textContent) {
        log(`[skills] Skill resource ${resource.uri} returned no text content, skipping`);
        continue;
      }

      const parsed = parseFrontmatter(textContent.text);
      const fm = parsed.frontmatter as Record<string, unknown>;
      const name = (fm.name as string | undefined) ?? resource.name;
      const description = (fm.description as string | undefined) ?? "";
      const allowedTools = parseAllowedTools(fm);

      if (!name) {
        log(`[skills] Skill at ${resource.uri} has no name, skipping`);
        continue;
      }

      skills.push({
        name,
        description,
        uri: resource.uri,
        serverName,
        allowedTools,
      });

      log(
        `[skills] Discovered skill "${name}" from "${serverName}" (${allowedTools.length} gated tools)`,
      );
    } catch (err) {
      log(`[skills] Failed to read skill ${resource.uri}: ${(err as Error).message}`);
    }
  }

  return skills.sort((left, right) => compareStrings(left.name, right.name));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Parse tool names from frontmatter, supporting both formats:
 * - Current: `allowed-tools: [tool_a, tool_b]` (YAML array)
 * - Proposed spec: `metadata.io.modelcontextprotocol/tools: "tool_a tool_b"` (space-separated)
 *
 * Prefers the proposed spec format when both are present.
 */
function parseAllowedTools(fm: Record<string, unknown>): string[] {
  // Proposed spec format: metadata.io.modelcontextprotocol/tools (space-separated string)
  const metadata = fm.metadata as Record<string, unknown> | undefined;
  if (metadata) {
    const specTools = metadata["io.modelcontextprotocol/tools"];
    if (typeof specTools === "string" && specTools.trim().length > 0) {
      return specTools.trim().split(/\s+/);
    }
  }

  // Current format: allowed-tools (YAML array)
  const legacy = fm["allowed-tools"];
  if (Array.isArray(legacy)) {
    return legacy.filter((v): v is string => typeof v === "string");
  }

  return [];
}
