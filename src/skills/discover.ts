import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { parseFrontmatter } from "@sammorrowdrums/mcpi";
import type { McpSkillMetadata } from "./skill-registry.js";

/**
 * Discover skills from a connected MCP server by reading its resources.
 *
 * Looks for resources with `skill://` URIs ending in `/SKILL.md`,
 * reads each one, and parses YAML frontmatter for skill metadata.
 */
export async function discoverSkillsFromServer(
  client: Client,
  serverName: string,
  log: (msg: string) => void = console.error,
): Promise<McpSkillMetadata[]> {
  const skills: McpSkillMetadata[] = [];

  let resources: { uri: string; name: string }[];
  try {
    const result = await client.listResources();
    resources = result.resources;
  } catch {
    log(
      `[skills] Server "${serverName}" does not support resources/list, skipping skill discovery`,
    );
    return skills;
  }

  const skillResources = resources.filter(
    (r) => r.uri.startsWith("skill://") && r.uri.endsWith("/SKILL.md"),
  );

  if (skillResources.length === 0) return skills;

  for (const resource of skillResources) {
    try {
      const result = await client.readResource({ uri: resource.uri });
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
      const allowedTools = parseAllowedTools(fm["allowed-tools"]);

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

  return skills;
}

function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string");
  }
  return [];
}
