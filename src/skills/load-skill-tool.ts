import type { AgentToolResult, ExtensionContext } from "@sammorrowdrums/mcpi";
import { Type, type Static } from "typebox";
import { stripFrontmatter } from "../frontmatter.js";
import type { McpPolicy } from "../mcp/policy.js";
import type { SkillsExtensionClient } from "./sep2640/client.js";
import { loadSkillDocument, SkillFetchBudget } from "./sep2640/load.js";
import { resourceSetFingerprint, type SkillEntry } from "./sep2640/protocol.js";
import type { McpSkillMetadata, SkillRegistry } from "./skill-registry.js";

const LoadSkillParams = Type.Object({
  name: Type.String({ description: "Name of the MCP skill to load" }),
});

type LoadSkillInput = Static<typeof LoadSkillParams>;

export interface LoadSkillDeps {
  registry: SkillRegistry;
  policy: McpPolicy;
  /**
   * Client for the draft skills extension.
   *
   * Required to load a skill discovered over SEP-2640: that contract only holds
   * if the digests are re-fetched at load time, so a skill with no client to
   * ask is refused rather than loaded unverified.
   */
  skillsClient?: SkillsExtensionClient;
}

export interface LoadSkillDetails {
  skillName: string;
  serverName?: string;
  /**
   * Tool definitions this skill revealed, for the conversation-tail
   * `tool_reference` blocks a provider expands schemas from.
   */
  referencedTools?: string[];
  error?: string;
  /** True when the content was verified against SEP-2640 digests. */
  verified?: boolean;
  /** True when the server's resource set changed since discovery. */
  resourceSetRotated?: boolean;
}

/**
 * Create the load_skill tool definition.
 *
 * When the model calls this tool, it:
 * 1. Looks up the skill in the registry
 * 2. Reads the full SKILL.md content through the shared policy boundary
 * 3. Activates the skill's tool-definition references
 * 4. Returns the SKILL.md body together with the names of the tool definitions
 *    it revealed
 *
 * Step 3 asks the user nothing. Revealing a schema is a context-engineering
 * act, and the series' own end-to-end trajectory has no approval step between
 * `load_skill` and the tools becoming visible. Approval happens later and
 * elsewhere: when a non-read-only tool actually runs, whichever surface runs
 * it. Loading a skill therefore widens what the model can *read*, never what it
 * may *do* — the tools a skill names were already dispatchable, and the ones it
 * omits still are.
 *
 * Nothing here mutates the registered tools array. The revealed definitions
 * ride out in this tool result, on the conversation tail, so the prompt prefix
 * and tool declarations stay byte-identical for the whole conversation.
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, policy, skillsClient } = deps;

  return {
    name: "load_skill",
    label: "Load Skill",
    description:
      "Use when a task matches an MCP skill's documented workflow and you need its instructions. Returns the skill body and reveals the full schemas of the tool definitions it references.",
    promptSnippet:
      "Use when a task matches an MCP skill's workflow: returns its instructions and reveals the schemas of the tools it references.",
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

      const verifiable = skill.origin === "sep2640";
      if (verifiable && !skillsClient) {
        return {
          content: [
            {
              type: "text",
              text: `Skill "${params.name}" was discovered over the draft skills extension, but no extension client is available to verify it. Refusing to load unverified content.`,
            },
          ],
          details: {
            skillName: params.name,
            serverName: skill.serverName,
            error: "verification_unavailable",
            verified: false,
          },
        };
      }

      let body: string;
      let entry: SkillEntry | undefined;
      let rotated = false;
      try {
        if (verifiable && skillsClient) {
          // Re-fetch the entry so verification uses the digests the server is
          // publishing now, not the ones it published at discovery.
          entry = await skillsClient.getSkill(skill.serverName, skill.uri, signal);
          const fingerprint = resourceSetFingerprint(entry);
          rotated =
            skill.contentFingerprint !== undefined && skill.contentFingerprint !== fingerprint;
          policy.registerSkillResources(
            skill.serverName,
            entry.uri,
            entry.resources === "dynamic" ? [] : entry.resources.map((ref) => ref.uri),
          );
          const document = await loadSkillDocument({
            policy,
            entry,
            serverName: skill.serverName,
            budget: new SkillFetchBudget(),
            ...(signal ? { signal } : {}),
          });
          body = stripFrontmatter(document.text);
        } else {
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
              details: {
                skillName: params.name,
                serverName: skill.serverName,
                error: "no_content",
              },
            };
          }
          body = stripFrontmatter(textContent.text);
        }
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
            verified: false,
          },
        };
      }

      // Activation is bound to the resource set the server just published, so a
      // rotated set reveals the definitions the server names now rather than
      // the ones it named at discovery. No approval is involved either way.
      const activationSubject = entry ? withFreshContent(skill, entry) : skill;
      const activation = policy.activateSkillReference(activationSubject);
      const revealed = [...activation.referencedTools];
      return {
        content: [{ type: "text", text: body }],
        // `addedToolNames` is the host's activation channel: it rides out on
        // this tool result, so the provider expands the revealed schemas from
        // `tool_reference` blocks on the conversation tail. Nothing mutates the
        // registered tools array or the system prompt, so the prompt prefix
        // stays byte-identical across the conversation. Omitted when empty,
        // because an empty array would still be a transcript marker.
        ...(revealed.length > 0 ? { addedToolNames: revealed } : {}),
        details: {
          skillName: params.name,
          serverName: skill.serverName,
          referencedTools: revealed,
          verified: verifiable,
          resourceSetRotated: rotated,
        },
      };
    },
  };
}

/**
 * Rebuild skill metadata from the entry the server just served.
 *
 * Both the referenced tool names and the content fingerprint come from the
 * verified entry rather than the discovery-time copy, so what the model is
 * shown is what the server is publishing now.
 */
function withFreshContent(skill: McpSkillMetadata, entry: SkillEntry): McpSkillMetadata {
  const declared = entry.frontmatter["allowed-tools"];
  const referencedTools = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === "string")
    : typeof declared === "string" && declared.trim().length > 0
      ? declared.trim().split(/\s+/)
      : [];
  return {
    ...skill,
    referencedTools,
    contentFingerprint: resourceSetFingerprint(entry),
  };
}
