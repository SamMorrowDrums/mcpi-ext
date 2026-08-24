import type { AgentToolResult, ExtensionContext } from "@sammorrowdrums/mcpi";
import { stripFrontmatter } from "@sammorrowdrums/mcpi";
import { Type, type Static } from "typebox";
import type { McpPolicy } from "../mcp/policy.js";
import type { SkillRegistry } from "./skill-registry.js";

const LoadSkillParams = Type.Object({
  name: Type.String({ description: "Name of the MCP skill to load" }),
});

type LoadSkillInput = Static<typeof LoadSkillParams>;

export interface LoadSkillDeps {
  registry: SkillRegistry;
  policy: McpPolicy;
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
 * 2. Reads the full SKILL.md content through the shared policy boundary
 * 3. Asks the user to approve the skill's `allowed-tools` grant
 * 4. Returns the SKILL.md body (the skill names its tools, and the model
 *    already has their schemas from the deferred tools array)
 *
 * The grant is requested before the body is returned, so a server cannot use
 * skill instructions to influence a pending authorization decision. A declined
 * or unavailable approval leaves every gated tool locked.
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, policy } = deps;

  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load an MCP skill by name. Activates the skill's instructions and tools.",
    promptSnippet: "Load an MCP skill to get specialized instructions and activate its tools.",
    parameters: LoadSkillParams,

    async execute(
      _toolCallId: string,
      params: LoadSkillInput,
      signal: AbortSignal | undefined,
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

      let body: string;
      try {
        const result = await policy.readResource({
          source: "skill-load",
          serverName: skill.serverName,
          uri: skill.uri,
          ...(signal ? { signal } : {}),
        });
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

      // The skill's tool grant needs explicit user approval before activation.
      const grant = await policy.activateSkillGrant(skill, signal);
      if (grant.status === "granted" || grant.status === "reused") {
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
            activatedTools: [...grant.activatedTools],
          },
        };
      }

      return {
        content: [{ type: "text", text: grant.message }],
        details: {
          skillName: params.name,
          serverName: skill.serverName,
          activatedTools: [],
          error: grant.status === "declined" ? "approval_declined" : "approval_unavailable",
        },
      };
    },
  };
}
