import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
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
  pi: ExtensionAPI;
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
 * 3. Adds the skill's allowed-tools to the active tool set
 * 4. Returns the SKILL.md body (instructions) to the model
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, mcpManager, pi } = deps;

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

      // Activate allowed-tools (already pre-registered as proxies at session_start)
      let activatedTools: string[] = [];
      if (skill.allowedTools.length > 0) {
        const currentTools = pi.getActiveTools();
        activatedTools = skill.allowedTools.filter((t) => !currentTools.includes(t));
        if (activatedTools.length > 0) {
          pi.setActiveTools([...currentTools, ...activatedTools]);
        }
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
          activatedTools,
        },
      };
    },
  };
}
