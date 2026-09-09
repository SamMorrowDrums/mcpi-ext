import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { McpTool } from "../mcp/index.js";

/**
 * The real tool surface of `ghcr.io/github/github-mcp-server` with
 * `GITHUB_TOOLSETS=all`, captured over stdio.
 *
 * Budget gates run against this rather than a hand-written sample: 89 tools,
 * 510 input properties, and zero declared output schemas is the shape that
 * actually broke, and a synthetic fixture would quietly make the numbers nicer.
 */
export function loadGithubFixture(serverName = "github"): McpTool[] {
  const path = fileURLToPath(new URL("./fixtures/github-89.json", import.meta.url));
  const tools = JSON.parse(readFileSync(path, "utf8")) as Omit<McpTool, "serverName">[];
  return tools.map((tool) => ({ ...tool, serverName }) as McpTool);
}

/** Conservative token estimate. Deliberately an under-count, so gates bite early. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
