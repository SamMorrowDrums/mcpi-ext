import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpTool } from "../mcp/index.js";

/**
 * The real tool surface of `ghcr.io/github/github-mcp-server` with
 * `GITHUB_TOOLSETS=all`, captured over stdio.
 *
 * Budget gates run against this rather than a hand-written sample: 85 tools,
 * 466 input properties, 31 declared output schemas and 54 synthesized is the
 * shape that actually broke, and a synthetic fixture would quietly make the
 * numbers nicer.
 *
 * This pins one configuration, not "the server". The surface is
 * capability-dependent: a host advertising form elicitation is additionally
 * served the gated `delete_repository`, which is where the earlier count of 86
 * came from. This capture is the no-form-elicitation configuration, so
 * regenerating it against an elicitation-capable host will not reproduce these
 * counts.
 */
export function loadGithubFixture(serverName = "github"): McpTool[] {
  const path = fileURLToPath(new URL("./fixtures/github-85.json", import.meta.url));
  const tools = JSON.parse(readFileSync(path, "utf8")) as Omit<McpTool, "serverName">[];
  return tools.map((tool) => ({ ...tool, serverName }) as McpTool);
}

/** The `_meta` key the experimental github-mcp-server publishes toolsets under. */
export const GITHUB_TOOLSET_KEY = "com.github.mcp.experimental/toolset";

/** One shipped toolset declaration, exactly as it appears on the wire. */
export interface ShippedToolset {
  readonly v: number;
  readonly id: string;
  readonly title?: string;
  readonly summary?: string;
  readonly effect?: string;
  readonly parent?: string;
}

/**
 * The 21 toolsets the experimental github-mcp-server publishes.
 *
 * Transcribed from the shipped server rather than invented here. Budget gates
 * that run against a handful of made-up namespaces prove nothing: the real
 * vocabulary is seven times larger, carries titles and prose summaries, and
 * includes a parent edge — all of which cost tokens that a small sample hides.
 *
 * Note the published set is not the declared set: `copilot_spaces` and
 * `github_support_docs_search` are feature-flagged off, so 23 declared toolsets
 * publish as 21.
 */
export function loadGithubToolsets(): ShippedToolset[] {
  const path = fileURLToPath(new URL("./fixtures/github-toolsets-21.json", import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as ShippedToolset[];
}

/**
 * Spread tools across the shipped toolsets so every namespace is populated.
 *
 * Which tool lands in which toolset does not matter for a prompt budget — the
 * rendered block carries no tool names and no counts, which is the property
 * under test. What matters is that all 21 declarations are present.
 */
export function withShippedToolsets(tools: readonly McpTool[]): McpTool[] {
  const toolsets = loadGithubToolsets();
  return tools.map((tool, index) => {
    const toolset = toolsets[index % toolsets.length] as ShippedToolset;
    return { ...tool, _meta: { [GITHUB_TOOLSET_KEY]: toolset } } as McpTool;
  });
}

/** Conservative token estimate. Deliberately an under-count, so gates bite early. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
