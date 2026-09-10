import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { buildCatalogSnapshot } from "./catalog.js";
import { toCodeModeTool } from "./eligibility.js";
import { estimateTokens, loadGithubFixture } from "./fixtures.js";
import { deriveNamespaces } from "./namespaces.js";
import { hashNamespaceBlock, renderNamespaceBlock, renderPromptSection } from "./prompt.js";

const TOOLSET_KEY = "com.github.mcp.experimental/toolset";

/** Attach declared toolset metadata, as the experimental server will. */
function withToolsets(tools: McpTool[]): McpTool[] {
  const toolsetFor = (name: string): string => {
    if (name.includes("issue")) return "issues";
    if (name.includes("pull_request")) return "pull_requests";
    if (name.includes("workflow") || name.includes("job")) return "actions";
    return "repos";
  };
  const summaries: Record<string, string> = {
    issues: "GitHub Issues related tools",
    pull_requests: "GitHub Pull Request related tools",
    actions: "GitHub Actions workflows and jobs",
    repos: "Repository contents, branches, and metadata",
  };

  return tools.map((tool) => {
    const id = toolsetFor(tool.name);
    return {
      ...tool,
      _meta: { [TOOLSET_KEY]: { v: 1, id, summary: summaries[id], effect: "mixed" } },
    } as McpTool;
  });
}

function namespacesFor(tools: McpTool[]) {
  return deriveNamespaces(tools);
}

describe("turn-0 prompt budget", () => {
  const tools = loadGithubFixture();
  const declared = withToolsets(tools);

  it("emits zero per-tool name tokens", () => {
    const section = renderPromptSection({
      namespaces: namespacesFor(declared),
      sandboxAvailable: true,
    });

    const leaked = tools.filter((tool) => section.includes(tool.name));
    expect(leaked.map((tool) => tool.name)).toEqual([]);
  });

  it("emits zero per-tool description tokens", () => {
    const section = renderPromptSection({
      namespaces: namespacesFor(declared),
      sandboxAvailable: true,
    });

    const leaked = tools.filter((tool) => {
      const description = tool.description?.trim();
      if (!description || description.length < 24) return false;
      return section.includes(description.slice(0, 24));
    });
    expect(leaked.map((tool) => tool.name)).toEqual([]);
  });

  it("keeps namespace summaries under 1,500 tokens", () => {
    const block = renderNamespaceBlock(namespacesFor(declared));
    expect(estimateTokens(block)).toBeLessThanOrEqual(1_500);
  });

  it("keeps the whole section under the 6,000-token discovery residual", () => {
    const section = renderPromptSection({
      namespaces: namespacesFor(declared),
      sandboxAvailable: true,
    });
    expect(estimateTokens(section)).toBeLessThanOrEqual(6_000);
  });

  it("collapses to a stable server-only block when nothing is declared", () => {
    // The fixture now carries the server's real `_meta`, so undeclared has to
    // be constructed explicitly rather than assumed: this is the server that
    // publishes no toolset vocabulary at all.
    const undeclared = tools.map(({ _meta: _ignored, ...rest }) => rest as McpTool);
    const block = renderNamespaceBlock(namespacesFor(undeclared));
    // 85 undeclared tools must not produce 85 lines.
    expect(block.split("\n").length).toBeLessThanOrEqual(3);
    expect(estimateTokens(block)).toBeLessThanOrEqual(50);
  });

  it("teaches the raw result envelope and structuredContent pagination", () => {
    const section = renderPromptSection({
      namespaces: namespacesFor(declared),
      sandboxAvailable: true,
    });

    expect(section).toContain("raw MCP CallToolResult envelope");
    expect(section).toContain("result.structuredContent");
    expect(section).toContain("result.structuredContent === undefined");
    expect(section).not.toContain("result.items");
  });

  it("allows only bounded inspect recovery and never treats retries as extra call budget", () => {
    const section = renderPromptSection({
      namespaces: namespacesFor(declared),
      sandboxAvailable: true,
    });

    expect(section).toContain("Plan discovery first, then make one `code_execute`");
    expect(section).toContain("one bounded inspection execution and one corrected retry");
    expect(section).toContain("not a way around the per-execution tool-call budget");
  });
});

describe("namespace block stability", () => {
  const declared = withToolsets(loadGithubFixture());
  const baseline = hashNamespaceBlock(namespacesFor(declared));
  const first = declared[0] as McpTool;

  it("is unchanged when a tool is removed", () => {
    const removed = declared.filter((tool) => tool.name !== first.name);
    expect(hashNamespaceBlock(namespacesFor(removed))).toBe(baseline);
  });

  it("is unchanged when a tool is renamed", () => {
    const renamed = declared.map((tool, index) =>
      index === 0 ? ({ ...tool, name: `${tool.name}_v2` } as McpTool) : tool,
    );
    expect(hashNamespaceBlock(namespacesFor(renamed))).toBe(baseline);
  });

  it("is unchanged when a tool is added to an existing namespace", () => {
    const added = [...declared, { ...first, name: "brand_new_issue_tool" } as McpTool];
    expect(hashNamespaceBlock(namespacesFor(added))).toBe(baseline);
  });

  it("changes token count by 0% when every namespace doubles its tools", () => {
    const doubled = [
      ...declared,
      ...declared.map((tool) => ({ ...tool, name: `${tool.name}_dup` }) as McpTool),
    ];
    const before = estimateTokens(renderNamespaceBlock(namespacesFor(declared)));
    const after = estimateTokens(renderNamespaceBlock(namespacesFor(doubled)));

    expect(hashNamespaceBlock(namespacesFor(doubled))).toBe(baseline);
    expect(Math.abs(after - before) / before).toBeLessThanOrEqual(0.02);
  });
});

describe("catalog reachability", () => {
  it("keeps every fixture tool addressable by canonical ref", () => {
    const snapshot = buildCatalogSnapshot(loadGithubFixture().map(toCodeModeTool));
    expect(snapshot.entries).toHaveLength(85);
    for (const entry of snapshot.entries) {
      expect(snapshot.byRef.get(entry.ref)).toBe(entry);
    }
  });

  it("records which output schemas the server actually declares", () => {
    const snapshot = buildCatalogSnapshot(loadGithubFixture().map(toCodeModeTool));
    const byProvenance = (value: string) =>
      snapshot.entries.filter((entry) => entry.entry.outputSchemaProvenance === value).length;

    // The integrated server declares 31 of 85. The rest get a permissive
    // survival floor and are reported as `synthesized` — the point being that
    // an absent schema is marked unknown rather than dressed up as a type.
    expect(byProvenance("declared")).toBe(31);
    expect(byProvenance("synthesized")).toBe(54);
    expect(byProvenance("declared") + byProvenance("synthesized")).toBe(85);
  });
});
