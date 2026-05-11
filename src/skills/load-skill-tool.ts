import type { AgentToolResult, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { stripFrontmatter } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { McpClientManager, McpTool } from "../mcp/index.js";
import type { SkillRegistry } from "./skill-registry.js";

const LoadSkillParams = Type.Object({
  name: Type.String({ description: "Name of the MCP skill to load" }),
});

type LoadSkillInput = Static<typeof LoadSkillParams>;

export interface LoadSkillDeps {
  registry: SkillRegistry;
  mcpManager: McpClientManager;
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
 * 3. Returns the SKILL.md body + tool schemas so the model learns about deferred tools
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, mcpManager } = deps;

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

      // Build result: skill body + tool schemas for deferred tools
      let resultText = body;

      if (skill.allowedTools.length > 0) {
        const allTools = mcpManager.getTools();
        const toolSchemas = formatToolSchemas(skill.allowedTools, allTools);
        if (toolSchemas) {
          resultText += "\n\n" + toolSchemas;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: resultText,
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

/**
 * Format tool schemas for inclusion in the load_skill result.
 *
 * Returns a text block describing each tool's name, description, and parameter
 * schema so the model knows how to call the deferred tools it just discovered.
 */
export function formatToolSchemas(toolNames: string[], allTools: McpTool[]): string | undefined {
  const tools = toolNames
    .map((name) => allTools.find((t) => t.name === name))
    .filter((t): t is McpTool => t !== undefined);

  if (tools.length === 0) return undefined;

  const lines = ["## Available Tools", ""];
  for (const tool of tools) {
    lines.push(`### ${tool.name}`);
    if (tool.description) {
      lines.push(tool.description);
    }
    lines.push("");
    lines.push("Parameters:");
    lines.push("```json");
    lines.push(JSON.stringify(tool.inputSchema, null, 2));
    lines.push("```");
    lines.push("");
  }

  return lines.join("\n");
}
