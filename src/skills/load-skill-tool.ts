import type { AgentToolResult, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { stripFrontmatter } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { McpClientManager } from "../mcp/index.js";
import type { SkillRegistry } from "./skill-registry.js";

const LoadSkillParams = Type.Object({
  name: Type.String({ description: "Name of the MCP skill to load" }),
});

type LoadSkillInput = Static<typeof LoadSkillParams>;

export interface LoadSkillDeps {
  registry: SkillRegistry;
  mcpManager: McpClientManager;
  enabledTools: Set<string>;
}

export interface LoadSkillDetails {
  skillName: string;
  serverName?: string;
  activatedTools?: string[];
  error?: string;
}

/**
 * Create the load_skill tool definition.
 *
 * When the model calls this tool, it:
 * 1. Looks up the skill in the registry
 * 2. Reads the full SKILL.md content from the MCP server
 * 3. Returns the SKILL.md body (the skill names its tools, and the model
 *    already has their schemas from the deferred tools array)
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, mcpManager, enabledTools } = deps;

  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load an MCP skill by name. Activates the skill's instructions and tools.",
    promptSnippet: "Load an MCP skill to get specialized instructions and activate its tools.",
    parameters: LoadSkillParams,

    async execute(
      _toolCallId: string,
      params: LoadSkillInput,
      _signal: AbortSignal | undefined,
      _onUpdate: undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<LoadSkillDetails>> {
      const skill = registry.get(params.name);
      if (!skill) {
        const available = registry
          .getAll()
          .map((s) => s.name)
          .join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Skill "${params.name}" not found. Available skills: ${available || "(none)"}`,
            },
          ],
          details: { skillName: params.name, error: "not_found" },
        };
      }

      const client = mcpManager.getClient(skill.serverName);
      if (!client) {
        return {
          content: [
            {
              type: "text",
              text: `MCP server "${skill.serverName}" is not connected. Cannot load skill "${params.name}".`,
            },
          ],
          details: { skillName: params.name, serverName: skill.serverName, error: "disconnected" },
        };
      }

      let body: string;
      try {
        const result = await client.readResource({ uri: skill.uri });
        const textContent = result.contents.find(
          (c): c is { uri: string; text: string } => "text" in c,
        );
        if (!textContent) {
          return {
            content: [
              {
                type: "text",
                text: `Skill "${params.name}" returned no text content.`,
              },
            ],
            details: { skillName: params.name, serverName: skill.serverName, error: "no_content" },
          };
        }
        body = stripFrontmatter(textContent.text);
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to read skill "${params.name}" from server "${skill.serverName}": ${(err as Error).message}`,
            },
          ],
          details: {
            skillName: params.name,
            serverName: skill.serverName,
            error: (err as Error).message,
          },
        };
      }

      // Enable the skill's tools so the tool_call gate allows them
      for (const t of skill.allowedTools) {
        enabledTools.add(t);
      }

      return {
        content: [
          {
            type: "text",
            text: body,
          },
        ],
        details: {
          skillName: params.name,
          serverName: skill.serverName,
          activatedTools: skill.allowedTools,
        },
      };
    },
  };
}
