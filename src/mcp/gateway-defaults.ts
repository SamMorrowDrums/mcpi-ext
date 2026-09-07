import type { McpPolicyGateway } from "./policy.js";

/**
 * Gateway behaviour for a server that does not speak the draft SEP-2640 skills
 * extension.
 *
 * `getExtensionCapability` returns `undefined` — the honest answer for a server
 * that declared nothing — and the three request methods reject. They reject
 * rather than return empty results because reaching them at all would mean the
 * policy dispatched an extension request to a server that never declared the
 * extension, and a silent empty result would hide that bug.
 *
 * Spread this into any gateway that only implements the classic MCP surface.
 */
export const noSkillsExtensionGateway: Pick<
  McpPolicyGateway,
  "getExtensionCapability" | "requestSkillsList" | "requestSkillsGet" | "requestDirectoryRead"
> = {
  getExtensionCapability: () => undefined,
  requestSkillsList: () => Promise.reject(new Error(unsupported("skills/list"))),
  requestSkillsGet: () => Promise.reject(new Error(unsupported("skills/get"))),
  requestDirectoryRead: () => Promise.reject(new Error(unsupported("resources/directory/read"))),
};

function unsupported(method: string): string {
  return `This MCP server does not declare the skills extension, so ${method} is unavailable.`;
}
