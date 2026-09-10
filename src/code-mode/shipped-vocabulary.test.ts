import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import {
  GITHUB_TOOLSET_KEY,
  estimateTokens,
  loadGithubFixture,
  loadGithubToolsets,
  withShippedToolsets,
} from "./fixtures.js";
import {
  SUPPORTED_TOOLSET_VERSION,
  deriveNamespaces,
  namespaceForTool,
  readToolsetDeclaration,
} from "./namespaces.js";
import { buildCatalogSnapshot } from "./catalog.js";
import { browseNamespaces } from "./discovery.js";
import { toCodeModeTool } from "./eligibility.js";
import { hashNamespaceBlock, renderNamespaceBlock, renderPromptSection } from "./prompt.js";

/**
 * Gates against the toolset vocabulary the experimental github-mcp-server
 * actually ships, rather than a handful of namespaces written to fit.
 *
 * The rest of the prompt suite uses a four-namespace sample, which is fine for
 * asserting *shape* but useless as a budget: the real vocabulary is 21
 * namespaces with titles, prose summaries, and a parent edge. If the pinned
 * prompt is going to be defended as cheap, it has to be cheap against what
 * servers send.
 */

const tools = withShippedToolsets(loadGithubFixture());
const namespaces = deriveNamespaces(tools);

describe("shipped github toolset vocabulary", () => {
  it("derives every published namespace", () => {
    expect(namespaces).toHaveLength(21);
    expect(namespaces.every((entry) => entry.source === "server-declared")).toBe(true);
    // Both amendments this client asked for during contract review.
    expect(namespaces.find((entry) => entry.id === "orgs")?.title).toBe("Organizations");
    expect(namespaces.every((entry) => entry.title.length > 0)).toBe(true);
  });

  it("stays inside the turn-0 budget at full vocabulary", () => {
    const block = renderNamespaceBlock(namespaces);
    const section = renderPromptSection({ namespaces, sandboxAvailable: true });

    expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
    expect(estimateTokens(section)).toBeLessThanOrEqual(6000);
  });

  it("costs the same at 21 tools as at 85, because the block describes namespaces", () => {
    // The point of the rework is that turn-0 cost tracks the *vocabulary*, not
    // the catalog. One tool per namespace covers the same 21 namespaces as the
    // full server, so the rendered block must be byte-identical — not merely
    // similar in size. If per-tool bytes ever creep back in, this diverges.
    const seen = new Set<string>();
    const onePerNamespace = tools.filter((tool) => {
      const id = namespaceForTool(tool, namespaces) ?? "";
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    expect(onePerNamespace).toHaveLength(21);
    expect(onePerNamespace.length).toBeLessThan(tools.length);

    const full = renderNamespaceBlock(namespaces);
    const sparse = renderNamespaceBlock(deriveNamespaces(onePerNamespace));
    expect(sparse).toBe(full);

    // Pinned exactly, so a regression shows up as a diff rather than as a
    // budget that quietly crept toward its ceiling.
    const section = renderPromptSection({ namespaces, sandboxAvailable: true });
    expect(estimateTokens(full)).toBe(529);
    expect(estimateTokens(section)).toBe(1097);
  });

  it("names no tool, at any vocabulary size", () => {
    const section = renderPromptSection({ namespaces, sandboxAvailable: true });
    const named = loadGithubFixture()
      .map((tool) => tool.name)
      .filter((name) => section.includes(name));

    // The whole claim of the pinned prompt is that its cost does not scale with
    // the tool surface. One leaked name would make that false.
    expect(named).toEqual([]);
  });

  it("keeps the block hash stable when the tool surface churns", () => {
    const baseline = hashNamespaceBlock(namespaces);
    const doubled = [...tools, ...tools.map((tool) => ({ ...tool, name: `${tool.name}_v2` }))];

    expect(hashNamespaceBlock(deriveNamespaces(doubled))).toBe(baseline);
    expect(hashNamespaceBlock(deriveNamespaces(tools.slice(0, 40)))).toBe(baseline);
  });

  it("resolves the one parent edge to a declared namespace", () => {
    const ids = new Set(namespaces.map((entry) => entry.id));
    const children = namespaces.filter((entry) => entry.parent !== undefined);

    expect(children.map((entry) => entry.id)).toEqual(["copilot_issue_intents"]);
    // A dangling parent would render a namespace nobody can browse to.
    for (const child of children) expect(ids.has(child.parent as string)).toBe(true);
  });

  it("survives a namespace disappearing between sessions", () => {
    // Under `--read-only` the server withholds `copilot` and its child, because
    // neither declares a read-only tool. 21 becomes 19. The prompt is pinned per
    // session, so this is a between-sessions change and must simply be rendered
    // honestly rather than crash or leave a dangling parent.
    const readOnly = tools.filter((tool) => {
      const declared = readToolsetDeclaration(tool);
      return declared?.id !== "copilot" && declared?.id !== "copilot_issue_intents";
    });
    const reduced = deriveNamespaces(readOnly);

    expect(reduced).toHaveLength(19);
    expect(reduced.some((entry) => entry.parent !== undefined)).toBe(false);
    expect(hashNamespaceBlock(reduced)).not.toBe(hashNamespaceBlock(namespaces));
  });

  it("ignores a declaration from a contract version it cannot read", () => {
    const future = loadGithubFixture().map(
      (tool) =>
        ({
          ...tool,
          _meta: {
            [GITHUB_TOOLSET_KEY]: {
              v: SUPPORTED_TOOLSET_VERSION + 1,
              id: "issues",
              title: "Issues",
              summary: "Meaning of these fields may have changed",
              effect: "read",
            },
          },
        }) as McpTool,
    );

    // Not parsed optimistically. A v2 that redefined `effect` would otherwise be
    // read as a v1 safety claim, which is worse than admitting ignorance.
    expect(readToolsetDeclaration(future[0] as McpTool)).toBeUndefined();
    const derived = deriveNamespaces(future);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.source).toBe("server-only");
  });

  it("walks the hierarchy by reference rather than by nesting the prompt", () => {
    const snapshot = buildCatalogSnapshot(tools.map((tool) => toCodeModeTool(tool)));

    const roots = browseNamespaces(snapshot, {});
    const children = browseNamespaces(snapshot, { parent: "copilot" });

    expect(roots.namespaces).toHaveLength(21);
    expect(children.namespaces.map((entry) => entry.namespace)).toEqual(["copilot_issue_intents"]);
    expect(children.namespaces[0]?.parent).toBe("copilot");

    // The pinned block stays flat on purpose: indenting 21 namespaces to express
    // one edge costs tokens in every session to describe a relationship almost
    // no query needs. The edge is reachable through browse, where it is paid for
    // only when asked about, and that scales to a deeper tree without touching
    // the prompt.
    const block = renderNamespaceBlock(namespaces);
    expect(block).toContain("copilot_issue_intents");
    expect(block).not.toContain("    copilot_issue_intents");
  });

  it("reads the shipped shape field for field", () => {
    const shipped = loadGithubToolsets();
    const intents = shipped.find((entry) => entry.id === "copilot_issue_intents");
    const declared = readToolsetDeclaration({
      name: "x",
      serverName: "github",
      _meta: { [GITHUB_TOOLSET_KEY]: intents },
    } as unknown as McpTool);

    // Asserted against the fixture rather than against transcribed prose. This
    // test is about the field mapping — note `effect` on the wire becomes
    // `effects` internally — and the server is actively rewriting its summaries.
    // Pinning the current wording here would make an expected editorial change
    // look like a parser regression.
    expect(declared).toEqual({
      id: intents?.id,
      title: intents?.title,
      summary: intents?.summary,
      effects: intents?.effect,
      parent: intents?.parent,
    });
  });

  it("holds the budget even if every summary is rewritten to the cap", () => {
    // Fourteen summaries are currently near-contentless ("GitHub X related
    // tools") and are being rewritten to be useful, which means longer. Rather
    // than re-measure after they land, gate the worst case now: every namespace
    // carrying a summary and title at the maximum length the parser accepts.
    const worstCase = tools.map((tool, index) => {
      const declared = readToolsetDeclaration(tool);
      return {
        ...tool,
        _meta: {
          [GITHUB_TOOLSET_KEY]: {
            v: 1,
            id: declared?.id ?? `ns_${String(index)}`,
            title: "T".repeat(80),
            summary: "S".repeat(240),
            effect: "mixed",
          },
        },
      } as McpTool;
    });

    const saturated = deriveNamespaces(worstCase);
    expect(saturated).toHaveLength(21);

    const block = renderNamespaceBlock(saturated);
    const section = renderPromptSection({ namespaces: saturated, sandboxAvailable: true });

    // Over-long values are clamped rather than rejected, so a verbose server
    // cannot spend the prompt budget on this client's behalf.
    expect(saturated.every((entry) => entry.title.length <= 60)).toBe(true);
    expect(saturated.every((entry) => (entry.summary ?? "").length <= 160)).toBe(true);
    expect(estimateTokens(block)).toBeLessThanOrEqual(1500);
    expect(estimateTokens(section)).toBeLessThanOrEqual(6000);
  });
});
