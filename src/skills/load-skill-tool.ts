import type { AgentToolResult, ExtensionContext } from "@sammorrowdrums/mcpi";
import { stripFrontmatter } from "@sammorrowdrums/mcpi";
import { Type, type Static } from "typebox";
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
  activatedTools?: string[];
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
 * 3. Asks the user to approve the skill's `allowed-tools` grant
 * 4. Returns the SKILL.md body (the skill names its tools, and the model
 *    already has their schemas from the deferred tools array)
 *
 * The grant is requested before the body is returned, so a server cannot use
 * skill instructions to influence a pending authorization decision. A declined
 * or unavailable approval leaves every gated tool locked.
 */
export function createLoadSkillTool(deps: LoadSkillDeps) {
  const { registry, policy, skillsClient } = deps;

  return {
    name: "load_skill",
    label: "Load Skill",
    description:
      "Use when a task matches an MCP skill's documented workflow and you need its instructions. Returns the skill body and requests approval to enable the tools it declares; the tools stay locked unless that grant is approved.",
    promptSnippet:
      "Use when a task matches an MCP skill's workflow: returns its instructions and, once you approve the grant, enables the tools it declares.",
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

      // Approval is bound to the resource set the server just published. A
      // rotated set produces a different grant key, so a previously approved
      // skill is re-prompted instead of inheriting the old answer.
      const grantSubject = entry ? withFreshContent(skill, entry) : skill;
      const grant = await policy.activateSkillGrant(grantSubject, signal);
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
            verified: verifiable,
            resourceSetRotated: rotated,
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
 * Both the gated tool names and the content fingerprint come from the verified
 * entry rather than the discovery-time copy, so an `allowed-tools` list that
 * grew since discovery cannot ride in on an approval the user gave for a
 * smaller one.
 */
function withFreshContent(skill: McpSkillMetadata, entry: SkillEntry): McpSkillMetadata {
  const declared = entry.frontmatter["allowed-tools"];
  const allowedTools = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === "string")
    : typeof declared === "string" && declared.trim().length > 0
      ? declared.trim().split(/\s+/)
      : [];
  return {
    ...skill,
    allowedTools,
    contentFingerprint: resourceSetFingerprint(entry),
  };
}
