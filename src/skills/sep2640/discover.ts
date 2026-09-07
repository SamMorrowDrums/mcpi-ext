import type { McpPolicy } from "../../mcp/policy.js";
import type { McpSkillMetadata } from "../skill-registry.js";
import type { SkillsExtensionClient } from "./client.js";
import {
  frontmatterDescription,
  frontmatterName,
  resourceSetFingerprint,
  type SkillEntry,
} from "./protocol.js";

/** Outcome of a SEP-2640 discovery pass against one server. */
export interface Sep2640DiscoveryResult {
  readonly skills: McpSkillMetadata[];
  /** Entries the server offered that this host refused, with the reason. */
  readonly rejected: { readonly uri: string; readonly reason: string }[];
  /** True when the listing was cut short and is known to be incomplete. */
  readonly truncated: boolean;
  /** True when the listing was served from the freshness cache. */
  readonly fromCache: boolean;
}

/**
 * Discover skills from a server that declared the draft skills extension.
 *
 * This reads nothing. `skills/list` already carries each skill's frontmatter
 * verbatim, so name, description and gated tools are all available without
 * touching SKILL.md — which is precisely what lets this honour the spec's ban
 * on prefetching. The first byte of skill content is fetched at load time, and
 * only then.
 *
 * Each accepted entry's resource set is registered with the policy, which is
 * what later authorises reads: a file is readable because this entry listed it,
 * not because it happens to share a URI prefix.
 *
 * An empty result means "the server listed nothing right now". It is not proof
 * that the server has no skills, and callers must not cache it as such.
 */
export async function discoverSkillsViaExtension(
  policy: McpPolicy,
  client: SkillsExtensionClient,
  serverName: string,
  log: (msg: string) => void = console.error,
  signal?: AbortSignal,
): Promise<Sep2640DiscoveryResult> {
  const listing = await client.listSkills(serverName, signal);
  const skills: McpSkillMetadata[] = [];
  const rejected = [...listing.rejected];

  for (const entry of listing.skills) {
    const name = frontmatterName(entry);
    if (!name) {
      rejected.push({ uri: entry.uri, reason: "frontmatter is missing a name" });
      continue;
    }

    const fingerprint = resourceSetFingerprint(entry);
    policy.registerSkillResources(serverName, entry.uri, listedResourceUris(entry));

    skills.push({
      name,
      description: frontmatterDescription(entry) ?? "",
      uri: entry.uri,
      serverName,
      allowedTools: parseAllowedTools(entry.frontmatter),
      origin: "sep2640",
      contentFingerprint: fingerprint,
    });
  }

  for (const failure of rejected) {
    log(`[skills] Rejected skill ${failure.uri} from "${serverName}": ${failure.reason}`);
  }
  if (listing.truncated) {
    log(
      `[skills] Listing from "${serverName}" was truncated; this is a partial view, not the full skill set`,
    );
  }

  skills.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { skills, rejected, truncated: listing.truncated, fromCache: listing.fromCache };
}

/**
 * URIs this entry authorises for reading.
 *
 * A `"dynamic"` resource set authorises nothing up front — the policy's
 * allowlist stays empty and reads are refused. Dynamic skills are readable only
 * through an explicit per-read decision, which is the honest reading of a
 * server declining to say what its skill contains.
 */
function listedResourceUris(entry: SkillEntry): string[] {
  if (entry.resources === "dynamic") return [];
  return entry.resources.map((ref) => ref.uri);
}

/**
 * Read `allowed-tools` from verbatim SEP-2640 frontmatter.
 *
 * Only the spec-defined `allowed-tools` key is honoured here. The extension
 * reserves the `io.modelcontextprotocol/` metadata prefix but defines no keys
 * under it, so the legacy path's `io.modelcontextprotocol/tools` lookup is not
 * repeated on this contract.
 *
 * These names stay inert until the user approves the grant: parsing them is not
 * activating them.
 */
function parseAllowedTools(frontmatter: Record<string, unknown>): string[] {
  const declared = frontmatter["allowed-tools"];
  if (Array.isArray(declared)) {
    return declared.filter((value): value is string => typeof value === "string");
  }
  if (typeof declared === "string" && declared.trim().length > 0) {
    return declared.trim().split(/\s+/);
  }
  return [];
}
