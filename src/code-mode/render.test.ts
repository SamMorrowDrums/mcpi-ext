import { describe, expect, it } from "vitest";
import { DISCOVERY_RESPONSE_BYTE_CAP } from "./budgets.js";
import { renderDiscovery } from "./render.js";

const SNAPSHOT_ID = "a".repeat(64);

describe("model-visible discovery rendering", () => {
  it.each([
    {
      label: "browse",
      result: {
        op: "browse",
        snapshotId: SNAPSHOT_ID,
        namespaces: [
          {
            ref: "github/issues",
            server: "github",
            namespace: "issues",
            title: "Issues",
            summary: "Issue search and management",
            source: "server-declared",
            toolCount: 4,
          },
        ],
        note: "Narrow with search or list.",
      },
    },
    {
      label: "list",
      result: {
        op: "list",
        snapshotId: SNAPSHOT_ID,
        server: "github",
        tools: [
          {
            ref: "github/search_issues",
            namespace: "issues",
            effect: "read",
            params: "query",
          },
        ],
        totalMatches: 1,
        truncated: false,
      },
    },
    {
      label: "search",
      result: {
        op: "search",
        snapshotId: SNAPSHOT_ID,
        query: "assigned issue count",
        hits: [
          {
            ref: "github/search_issues",
            namespace: "issues",
            effect: "read",
            params: "query",
          },
        ],
        totalMatches: 1,
        truncated: false,
      },
    },
    {
      label: "describe",
      result: {
        op: "describe",
        snapshotId: SNAPSHOT_ID,
        signatures: [
          {
            ref: "github/search_issues",
            schemaHash: "b".repeat(64),
            signature: "github/search_issues [read]\n  schemaHash (not snapshotId): bbbbbbbbbbbb",
          },
        ],
        unresolved: [],
        truncated: false,
      },
    },
  ])("includes the full executable snapshotId for $label", ({ result }) => {
    const rendered = renderDiscovery(result);

    expect(rendered).toContain(
      `snapshotId (full; pass as code_execute.snapshotId): ${SNAPSHOT_ID}`,
    );
    expect(rendered).not.toContain(`snapshot ${SNAPSHOT_ID.slice(0, 12)}`);
  });

  it("keeps the full snapshotId when a response reaches the byte cap", () => {
    const rendered = renderDiscovery({
      op: "search",
      snapshotId: SNAPSHOT_ID,
      query: "issue",
      hits: Array.from({ length: 1000 }, (_, index) => ({
        ref: `github/search_issue_${String(index)}`,
        namespace: "issues",
        effect: "read",
        params: "query",
        description: "x".repeat(200),
      })),
      totalMatches: 1000,
      truncated: true,
    });

    expect(rendered).toContain(SNAPSHOT_ID);
    expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(DISCOVERY_RESPONSE_BYTE_CAP);
  });
});
