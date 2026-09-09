import { describe, expect, it } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { buildCatalogSnapshot, resolveTool, toolEffect } from "./catalog.js";
import { toCodeModeTool } from "./eligibility.js";

function tool(overrides: Partial<McpTool> & { name: string; serverName: string }): McpTool {
  return {
    inputSchema: { type: "object", properties: {} },
    ...overrides,
  } as McpTool;
}

function snapshotOf(tools: McpTool[]) {
  return buildCatalogSnapshot(tools.map(toCodeModeTool));
}

describe("buildCatalogSnapshot", () => {
  it("assigns canonical refs and sorts deterministically", () => {
    const snapshot = snapshotOf([
      tool({ name: "zeta", serverName: "b" }),
      tool({ name: "alpha", serverName: "a" }),
    ]);

    expect(snapshot.entries.map((entry) => entry.ref)).toEqual(["a/alpha", "b/zeta"]);
    expect(snapshot.servers).toEqual(["a", "b"]);
  });

  it("offers a flat alias only when the tool name is globally unique", () => {
    const snapshot = snapshotOf([
      tool({ name: "shared", serverName: "a" }),
      tool({ name: "shared", serverName: "b" }),
      tool({ name: "unique", serverName: "a" }),
    ]);

    expect(snapshot.byRef.get("a/shared")?.alias).toBeUndefined();
    expect(snapshot.byRef.get("b/shared")?.alias).toBeUndefined();
    expect(snapshot.byRef.get("a/unique")?.alias).toBe("unique");
  });

  it("withholds an alias when sanitizing would collide", () => {
    const snapshot = snapshotOf([
      tool({ name: "a.b", serverName: "s" }),
      tool({ name: "a-b", serverName: "s" }),
    ]);

    expect(snapshot.byAlias.has("a_b")).toBe(false);
  });

  it("changes the snapshot id when a schema changes", () => {
    const before = snapshotOf([tool({ name: "t", serverName: "s" })]);
    const after = snapshotOf([
      tool({
        name: "t",
        serverName: "s",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      }),
    ]);

    expect(after.snapshotId).not.toBe(before.snapshotId);
  });

  it("keeps the snapshot id stable when only ordering changes", () => {
    const first = snapshotOf([
      tool({ name: "a", serverName: "s" }),
      tool({ name: "b", serverName: "s" }),
    ]);
    const second = snapshotOf([
      tool({ name: "b", serverName: "s" }),
      tool({ name: "a", serverName: "s" }),
    ]);

    expect(second.snapshotId).toBe(first.snapshotId);
  });
});

describe("resolveTool", () => {
  const snapshot = snapshotOf([
    tool({ name: "shared", serverName: "a" }),
    tool({ name: "shared", serverName: "b" }),
    tool({ name: "unique", serverName: "a" }),
  ]);

  it("resolves a canonical ref", () => {
    const result = resolveTool(snapshot, "a/shared");
    expect(result.ok && result.entry.serverName).toBe("a");
  });

  it("resolves a bare name when it is unique", () => {
    const result = resolveTool(snapshot, "unique");
    expect(result.ok && result.entry.ref).toBe("a/unique");
  });

  it("refuses an ambiguous bare name and names the alternatives", () => {
    const result = resolveTool(snapshot, "shared");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("ambiguous_tool");
    expect(result.candidates).toEqual(["a/shared", "b/shared"]);
  });

  it("refuses an unknown reference", () => {
    const result = resolveTool(snapshot, "nope");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unknown_tool");
  });

  it("rejects a namespace-qualified ref whose namespace does not match", () => {
    const result = resolveTool(snapshot, "a/wrong-namespace/unique");
    expect(result.ok).toBe(false);
  });
});

describe("toolEffect", () => {
  it("classifies declared read-only tools as read", () => {
    expect(
      toolEffect(tool({ name: "t", serverName: "s", annotations: { readOnlyHint: true } })),
    ).toBe("read");
  });

  it("classifies destructive tools as write even when marked read-only", () => {
    expect(
      toolEffect(
        tool({
          name: "t",
          serverName: "s",
          annotations: { readOnlyHint: true, destructiveHint: true },
        }),
      ),
    ).toBe("write");
  });

  it("reports unknown rather than guessing when nothing is declared", () => {
    expect(toolEffect(tool({ name: "t", serverName: "s" }))).toBe("unknown");
  });
});
