import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicy } from "../mcp/policy.js";
import type { ExecuteResult } from "./executor.js";
import { CodeModeManager } from "./index.js";

const structuredValues: CallToolResult["structuredContent"][] = [
  false,
  0,
  "",
  null,
  [],
  { nested: ["value"] },
];

describe("CodeModeManager reliability", () => {
  it("runs pure deterministic computation without an MCP manager", async () => {
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });

    const result = await codeMode.executeCode(`
      const parsed = JSON.parse('{"values":[3,5,8]}');
      return parsed.values.map((value) => value * 2);
    `);

    expect(result).toMatchObject({ result: [6, 10, 16], logs: [] });
    // Every run reports what it read, even when that is nothing.
    expect(result.provenance).toEqual({
      readServers: [],
      lowestTrust: "none",
      attemptedWrite: false,
    });
    expect(codeMode.isActive).toBe(true);
  });

  it("answers discovery without entering the sandbox", async () => {
    const sandboxExecutor = vi.fn(async (): Promise<ExecuteResult> => ({
      result: ["write_records"],
      logs: [],
    }));
    const codeMode = new CodeModeManager({ sandboxExecutor });
    initCodeMode(
      codeMode,
      [makeTool("write_records", { annotations: { readOnlyHint: false } })],
      vi.fn(),
    );

    const { codeSearch } = codeMode.createTools();
    const result = await codeSearch.execute(
      "discover",
      { op: "search", query: "records" },
      undefined,
      undefined,
      {} as never,
    );

    expect(result.content[0]).toMatchObject({ type: "text" });
    expect(sandboxExecutor).not.toHaveBeenCalled();
  });

  it("indexes every tool for discovery, including tools it will not be allowed to call", () => {
    const codeMode = new CodeModeManager();
    initCodeMode(
      codeMode,
      [
        makeTool("read_records", { annotations: { readOnlyHint: true } }),
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      vi.fn(),
    );

    const listed = codeMode.discover("list", { server: "fixture" }) as {
      tools: { ref: string }[];
    };
    expect(listed.tools.map((tool) => tool.ref)).toEqual([
      "fixture/read_records",
      "fixture/write_records",
    ]);
  });

  it("keeps declared and synthesized schema provenance distinct without mutating tools", () => {
    const declaredSchema = {
      type: "object",
      properties: { value: { type: "number" } },
      required: ["value"],
    } as const;
    const tools: McpTool[] = [
      makeTool("declared_read", {
        annotations: { readOnlyHint: true },
        outputSchema: declaredSchema,
      }),
      makeTool("schema_less_read", {
        annotations: { readOnlyHint: true },
      }),
      makeTool("write_records", {
        annotations: { readOnlyHint: false, destructiveHint: true },
      }),
    ];
    const logs: string[] = [];
    const codeMode = new CodeModeManager({ log: (message) => logs.push(message) });
    initCodeMode(codeMode, tools, vi.fn());

    expect(codeMode.getDiagnostics()).toEqual({
      totalTools: 3,
      unattendedTools: 2,
      approvalGatedTools: 1,
      declaredOutputSchemas: 1,
      synthesizedOutputSchemas: 2,
      unavailableOutputSchemas: 0,
    });
    expect(
      logs.some((message) =>
        message.includes("output schemas: 1 declared, 2 synthesized, 0 unavailable"),
      ),
    ).toBe(true);

    const catalog = codeMode.getCatalogTools();
    expect(catalog[0].outputSchema).toBe(declaredSchema);
    expect(catalog[0].tool.outputSchema).toBe(declaredSchema);
    expect(catalog[1]).toMatchObject({
      runsUnattended: true,
      outputSchemaProvenance: "synthesized",
    });
    expect(catalog[1].tool.outputSchema).toBeUndefined();
    expect(catalog[2]).toMatchObject({
      runsUnattended: false,
      outputSchemaProvenance: "synthesized",
    });
    expect(tools.every((tool) => !("codeMode" in tool))).toBe(true);
  });

  it("marks a declared output schema as typed and an absent one as unknown", () => {
    const codeMode = new CodeModeManager();
    initCodeMode(
      codeMode,
      [
        makeTool("declared_read", {
          annotations: { readOnlyHint: true },
          outputSchema: { type: "object", properties: { total: { type: "number" } } },
        }),
        makeTool("schema_less_read", { annotations: { readOnlyHint: true } }),
      ],
      vi.fn(),
    );

    const described = codeMode.discover("describe", {
      refs: ["fixture/declared_read", "fixture/schema_less_read"],
    }) as { signatures: { ref: string; signature: string }[] };

    const declared = described.signatures[0].signature;
    const undeclared = described.signatures[1].signature;

    expect(declared).toContain("total");
    // No schema means no claim about the shape. The model is told to look,
    // rather than handed a fabricated type it might trust.
    expect(undeclared).toContain("unknown");
    expect(undeclared).toContain("codemode.inspect");
  });

  it("pins the system prompt section across catalog changes", () => {
    const codeMode = new CodeModeManager();
    const manager = fakeManager(
      [makeTool("read_records", { annotations: { readOnlyHint: true } })],
      vi.fn(),
    );
    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));

    const pinned = codeMode.formatSystemPromptSection();
    const before = codeMode.getSnapshot().snapshotId;

    // A server connects mid-session and publishes 40 more tools.
    const grown = [
      makeTool("read_records", { annotations: { readOnlyHint: true } }),
      ...Array.from({ length: 40 }, (_, index) =>
        makeTool(`late_tool_${String(index)}`, {
          serverName: "late-server",
          annotations: { readOnlyHint: true },
        }),
      ),
    ];
    const grownManager = fakeManager(grown, vi.fn());
    codeMode.initialize(grownManager, new McpPolicy({ gateway: grownManager }));

    expect(codeMode.getSnapshot().snapshotId).not.toBe(before);
    // The prompt does not move: rewriting it would invalidate the provider
    // prefix cache for every remaining turn.
    expect(codeMode.formatSystemPromptSection()).toBe(pinned);
    // But the late server is fully reachable through discovery.
    const found = codeMode.discover("search", { query: "late_tool_7" }) as {
      hits: { ref: string }[];
    };
    expect(found.hits[0].ref).toBe("late-server/late_tool_7");
  });

  it("refuses an ambiguous bare tool name instead of guessing a server", async () => {
    const callTool = vi.fn();
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("list_issues", { serverName: "github", annotations: { readOnlyHint: true } }),
        makeTool("list_issues", { serverName: "gitlab", annotations: { readOnlyHint: true } }),
      ],
      callTool,
    );

    const result = await codeMode.executeCode(`return await codemode.callRef("list_issues", {});`);

    expect(result.errorDetails?.error).toBe("ambiguous_tool");
    expect(result.errorDetails?.candidates).toEqual(["github/list_issues", "gitlab/list_issues"]);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("surfaces a declined approval as a structured failure rather than a text success", async () => {
    const callTool = vi.fn(async () =>
      adaptTerminalCallToolResult({ content: [{ type: "text", text: "closed" }] }),
    );
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    // The user is asked and says no. A write is no longer refused before it is
    // put to them, so declining is the only way a denial arises — and it must
    // still reach the script as an error, never as a plausible-looking result.
    initCodeMode(
      codeMode,
      [
        makeTool("write_records", {
          annotations: { readOnlyHint: false, destructiveHint: true },
        }),
      ],
      callTool,
      false,
    );

    const denied = await codeMode.executeCode(
      'return await codemode.call("fixture", "write_records", { value: "unsafe" });',
    );

    expect(denied.result).toBeUndefined();
    expect(denied.errorDetails?.error).toBe("approval_declined");
    expect(denied.errorDetails?.toolName).toBe("write_records");
    // The error names the annotations that made the call ask, so a declined
    // write reads as "you said no to this", not "that tool was unreachable".
    expect(denied.errorDetails?.reason).toBe(
      "annotations.readOnlyHint is not true; annotations.destructiveHint is true",
    );
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each(structuredValues)(
    "preserves terminal structuredContent through synthesized-schema dispatch: %j",
    async (structuredContent) => {
      const protocolResult: CallToolResult = { content: [], structuredContent };
      const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
      const codeMode = new CodeModeManager({ timeoutMs: 5000 });
      initCodeMode(
        codeMode,
        [makeTool("schema_less_read", { annotations: { readOnlyHint: true } })],
        callTool,
      );

      const result = await codeMode.executeCode(`
        const terminal = await codemode.schema_less_read({});
        return terminal.structuredContent;
      `);

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(structuredContent);
      expect(callTool).toHaveBeenCalledWith("fixture", "schema_less_read", {}, undefined);
    },
  );

  it.each([false, 0, "", null])(
    "preserves falsey declared structuredContent inside the terminal envelope: %j",
    async (structuredContent) => {
      const protocolResult: CallToolResult = { content: [], structuredContent };
      const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
      const codeMode = new CodeModeManager({ timeoutMs: 5000 });
      initCodeMode(
        codeMode,
        [
          makeTool("declared_read", {
            annotations: { readOnlyHint: true },
            outputSchema: {},
          }),
        ],
        callTool,
      );

      const result = await codeMode.executeCode(`
        const terminal = await codemode.declared_read({});
        return terminal.structuredContent;
      `);

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual(structuredContent);
    },
  );

  it("preserves a declared mixed-content error envelope when structuredContent is absent", async () => {
    const protocolResult: CallToolResult = {
      content: [
        { type: "text", text: "GitHub rejected the query" },
        {
          type: "resource_link",
          uri: "https://api.github.com/issues/1",
          name: "issue",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///diagnostic.txt",
            text: "query diagnostic",
            mimeType: "text/plain",
          },
        },
      ],
      isError: true,
      _meta: { requestId: "request-123" },
    };
    const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("declared_read", {
          annotations: { readOnlyHint: true },
          outputSchema: {
            type: "object",
            properties: { total_count: { type: "number" } },
            required: ["total_count"],
          },
        }),
      ],
      callTool,
    );

    const result = await codeMode.executeCode("return await codemode.declared_read({});");

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(protocolResult);
    expect(result.result).not.toHaveProperty("structuredContent");
  });

  it("preserves a synthesized text-only result without inventing structuredContent", async () => {
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "plain text only" }],
      _meta: { source: "fixture" },
    };
    const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [makeTool("schema_less_read", { annotations: { readOnlyHint: true } })],
      callTool,
    );

    const result = await codeMode.executeCode("return await codemode.schema_less_read({});");

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(protocolResult);
    expect(result.result).not.toHaveProperty("structuredContent");
  });

  it("indexes and ranks skill-gated tools, because visibility is not authority", () => {
    const codeMode = new CodeModeManager();
    const manager = fakeManager(
      [
        makeTool("gated_search", { annotations: { readOnlyHint: true } }),
        makeTool("open_search", { annotations: { readOnlyHint: true } }),
      ],
      vi.fn(),
    );
    const policy = new McpPolicy({ gateway: manager });
    policy.registerSkills([
      {
        name: "reporting",
        uri: "skill://reporting",
        serverName: "fixture",
        referencedTools: ["gated_search"],
      },
    ]);
    codeMode.initialize(manager, policy);

    expect(policy.isDeferred("gated_search")).toBe(true);

    // Skill references decide which schemas the model can *read* on the direct
    // proxy surface. Letting that also decide what Code Mode can *see* would
    // hide a tool from search while the policy would have allowed the call.
    const found = codeMode.discover("search", { query: "search" }) as {
      hits: { ref: string }[];
    };
    expect(found.hits.map((hit) => hit.ref)).toContain("fixture/gated_search");
    expect(found.hits.map((hit) => hit.ref)).toContain("fixture/open_search");
  });

  it("returns byte-identical discovery before and after a skill is activated", async () => {
    const codeMode = new CodeModeManager();
    const manager = fakeManager(
      [
        makeTool("gated_search", { annotations: { readOnlyHint: true } }),
        makeTool("open_search", { annotations: { readOnlyHint: true } }),
        // D42: referenced by no skill at all. It exists to prove that
        // activating an unrelated skill does not perturb the ranking of tools
        // that skill never mentioned.
        makeTool("d42_search_regression", { annotations: { readOnlyHint: true } }),
      ],
      vi.fn(),
    );
    const policy = new McpPolicy({
      gateway: manager,
      approvals: { confirm: async () => true },
    });
    const skill = {
      name: "reporting",
      uri: "skill://reporting",
      serverName: "fixture",
      referencedTools: ["gated_search"],
    };
    policy.registerSkills([skill]);
    codeMode.initialize(manager, policy);

    const query = { query: "search", limit: 10 };
    const before = JSON.stringify(codeMode.discover("search", { ...query }));

    const outcome = policy.activateSkillReference(skill);
    expect(outcome.status).toBe("activated");
    expect(policy.isDeferred("gated_search")).toBe(false);

    const after = JSON.stringify(codeMode.discover("search", { ...query }));

    // Not "the same tools in some order" — the same bytes. If activation could
    // reorder hits, a model would see different search results depending on
    // which skills it happened to load, and the catalog would stop being a
    // stable thing to reason about across turns.
    expect(after).toBe(before);
    expect(before).toContain("fixture/d42_search_regression");
  });

  it("omits tools the gateway does not expose, so denial is absence not ranking", () => {
    const codeMode = new CodeModeManager();
    // A tenant-denied tool never reaches the gateway's tool list. Code Mode
    // indexes what it is given, so denial is invisible rather than demoted.
    const manager = fakeManager(
      [makeTool("permitted_search", { annotations: { readOnlyHint: true } })],
      vi.fn(),
    );
    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));

    const found = codeMode.discover("search", { query: "search", limit: 10 }) as {
      hits: { ref: string }[];
    };

    expect(found.hits.map((hit) => hit.ref)).toEqual(["fixture/permitted_search"]);
  });

  it("uses operator-curated namespaces for a server that declares none", () => {
    const codeMode = new CodeModeManager();
    codeMode.configureNamespaces({
      fixture: [{ id: "issues", title: "Issues", summary: "Issue tracking and triage" }],
    });
    const manager = fakeManager(
      [makeTool("read_records", { annotations: { readOnlyHint: true } })],
      vi.fn(),
    );
    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));

    const browsed = codeMode.discover("browse") as {
      namespaces: { ref: string; summary?: string; source: string }[];
    };

    expect(browsed.namespaces).toHaveLength(1);
    expect(browsed.namespaces[0].summary).toBe("Issue tracking and triage");
    // An operator wrote it, so it is a declaration — not something inferred
    // from tool names, which is why it may be rendered into a pinned prompt.
    expect(browsed.namespaces[0].source).toBe("operator-config");
  });

  it("refuses a ref that two different tools both render to", async () => {
    const callTool = vi.fn();
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    // A hostile server names a tool so that its ref collides with another
    // server's: "a" + "b/echo" renders the same string as "a/b" + "echo".
    initCodeMode(
      codeMode,
      [
        makeTool("echo", { serverName: "a/b", annotations: { readOnlyHint: true } }),
        makeTool("b/echo", { serverName: "a", annotations: { readOnlyHint: true } }),
      ],
      callTool,
    );

    const result = await codeMode.executeCode(`return await codemode.callRef("a/b/echo", {});`);

    expect(result.errorDetails?.error).toBe("ambiguous_tool");
    expect(callTool).not.toHaveBeenCalled();
  });

  it("routes a structured identity past a colliding ref", async () => {
    const callTool = vi.fn(async () => adaptTerminalCallToolResult({ content: [] }));
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [
        makeTool("echo", { serverName: "a/b", annotations: { readOnlyHint: true } }),
        makeTool("b/echo", { serverName: "a", annotations: { readOnlyHint: true } }),
      ],
      callTool,
    );

    const result = await codeMode.executeCode(`return await codemode.call("a/b", "echo", {});`);

    expect(result.error).toBeUndefined();
    expect(callTool).toHaveBeenCalledWith("a/b", "echo", {}, undefined);
  });

  it("keeps one execution on one snapshot even as the catalog changes underneath", async () => {
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [makeTool("read_records", { annotations: { readOnlyHint: true } })],
      vi.fn(async () => adaptTerminalCallToolResult({ content: [] })),
    );
    const pinned = codeMode.getSnapshot().snapshotId;

    // A refresh lands mid-script. Discovery must not jump to the newer
    // catalog, or a script could describe one tool and call another.
    const result = await codeMode.executeCode(`
      const first = await codemode.list({ server: "fixture" });
      await codemode.call("fixture", "read_records", {});
      const second = await codemode.list({ server: "fixture" });
      return [first.snapshotId, second.snapshotId];
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([pinned, pinned]);
  });

  it("moves the snapshot id when an effect class changes but schemas do not", () => {
    const outputSchema = { type: "object", properties: { ok: { type: "boolean" } } } as const;
    const read = new CodeModeManager();
    initCodeMode(
      read,
      [makeTool("act", { annotations: { readOnlyHint: true }, outputSchema })],
      vi.fn(),
    );

    const write = new CodeModeManager();
    initCodeMode(
      write,
      [makeTool("act", { annotations: { readOnlyHint: false }, outputSchema })],
      vi.fn(),
    );

    // Identical schemas, different authority. A fingerprint over schemas alone
    // would call these the same catalog.
    expect(read.getSnapshot().entries[0].schemaHash).toBe(
      write.getSnapshot().entries[0].schemaHash,
    );
    expect(read.getSnapshot().snapshotId).not.toBe(write.getSnapshot().snapshotId);
  });

  it("refuses a stale snapshot pin before starting the isolate", async () => {
    const sandboxExecutor = vi.fn(async (): Promise<ExecuteResult> => ({
      result: "ran anyway",
      logs: [],
    }));
    const codeMode = new CodeModeManager({ sandboxExecutor });
    initCodeMode(
      codeMode,
      [makeTool("read_records", { annotations: { readOnlyHint: true } })],
      vi.fn(),
    );

    const result = await codeMode.executeCode("return 1;", undefined, "sha256-of-an-older-catalog");

    expect(result.errorDetails?.error).toBe("stale_snapshot");
    expect(sandboxExecutor).not.toHaveBeenCalled();

    // The current id is accepted, so pinning is not a one-way trap.
    const fresh = await codeMode.executeCode(
      "return 1;",
      undefined,
      codeMode.getSnapshot().snapshotId,
    );
    expect(fresh.errorDetails).toBeUndefined();
    expect(sandboxExecutor).toHaveBeenCalledTimes(1);
  });

  it("hands a full describe snapshot to execution and recovers once after catalog drift", async () => {
    const searchOutputSchema = {
      type: "object",
      properties: {
        total_count: { type: "number" },
        incomplete_results: { type: "boolean" },
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { number: { type: "number" } },
            required: ["number"],
          },
        },
      },
      required: ["total_count", "incomplete_results", "items"],
    } as const;
    let tools = [
      makeTool("search_issues", {
        annotations: { readOnlyHint: true },
        outputSchema: searchOutputSchema,
      }),
    ];
    const protocolResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: '{"total_count":73,"incomplete_results":false,"items":[{"number":1}]}',
        },
      ],
      structuredContent: {
        total_count: 73,
        incomplete_results: false,
        items: [{ number: 1 }],
      },
      isError: false,
      _meta: { serverInfo: { name: "github-mcp-server" } },
    };
    const callTool = vi.fn(async () => adaptTerminalCallToolResult(protocolResult));
    const manager = mutableFakeManager(() => tools, callTool);
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));
    const { codeSearch, codeExecute } = codeMode.createTools();
    const runCode = (snapshotId: string, code: string) =>
      codeExecute.execute("execute", { code, snapshotId }, undefined, undefined, {} as never);

    const firstDescribe = await codeSearch.execute(
      "describe-1",
      { op: "describe", refs: ["fixture/search_issues"] },
      undefined,
      undefined,
      {} as never,
    );
    const firstText = firstDescribe.content.find((block) => block.type === "text")?.text ?? "";
    const firstSnapshot =
      /snapshotId \(full; pass as code_execute\.snapshotId\): ([a-f0-9]{64})/.exec(firstText)?.[1];
    expect(firstSnapshot).toBeDefined();
    if (!firstSnapshot) return;

    const firstRun = await runCode(
      firstSnapshot,
      `
        const result = await codemode.search_issues({ query: "is:issue is:open" });
        return {
          total: result.structuredContent.total_count,
          contentType: result.content[0].type,
          isError: result.isError,
          server: result._meta.serverInfo.name,
        };
      `,
    );
    const firstResultText = firstRun.content.find((block) => block.type === "text")?.text;
    expect(firstResultText ? JSON.parse(firstResultText) : undefined).toEqual({
      total: 73,
      contentType: "text",
      isError: false,
      server: "github-mcp-server",
    });
    expect(callTool).toHaveBeenCalledTimes(1);

    tools = [
      makeTool("search_issues", {
        annotations: { readOnlyHint: true },
        outputSchema: {
          ...searchOutputSchema,
          properties: {
            ...searchOutputSchema.properties,
            page_count: { type: "number" },
          },
        },
      }),
    ];
    callTool.mockClear();

    const stale = await runCode(
      firstSnapshot,
      "return await codemode.search_issues({ query: 'is:issue' });",
    );
    expect(stale.details.error).toBe("stale_snapshot");
    expect(stale.details.message).toContain("relevant code_search");
    expect(stale.details.message).toContain("new full snapshotId");
    expect(stale.details.message).toContain("intentional unpinned execution");
    expect(stale.details.message).toContain("gives up stale-catalog protection");
    expect(callTool).not.toHaveBeenCalled();

    const currentSchemaHash = codeMode.getSnapshot().entries[0].schemaHash;
    const schemaHashAttempt = await runCode(
      currentSchemaHash,
      "return await codemode.search_issues({ query: 'is:issue' });",
    );
    expect(schemaHashAttempt.details.error).toBe("stale_snapshot");
    expect(callTool).not.toHaveBeenCalled();

    const truncatedAttempt = await runCode(
      firstSnapshot.slice(0, 12),
      "return await codemode.search_issues({ query: 'is:issue' });",
    );
    expect(truncatedAttempt.details.error).toBe("stale_snapshot");
    expect(callTool).not.toHaveBeenCalled();

    const secondDescribe = await codeSearch.execute(
      "describe-2",
      { op: "describe", refs: ["fixture/search_issues"] },
      undefined,
      undefined,
      {} as never,
    );
    const secondText = secondDescribe.content.find((block) => block.type === "text")?.text ?? "";
    const secondSnapshot =
      /snapshotId \(full; pass as code_execute\.snapshotId\): ([a-f0-9]{64})/.exec(secondText)?.[1];
    expect(secondSnapshot).toBeDefined();
    expect(secondSnapshot).not.toBe(firstSnapshot);
    if (!secondSnapshot) return;

    const fresh = await runCode(
      secondSnapshot,
      `
        const result = await codemode.search_issues({ query: "is:issue is:open" });
        return result.structuredContent.total_count;
      `,
    );
    expect(fresh.content.find((block) => block.type === "text")?.text).toBe("73");
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("forwards host cancellation into the policy call", async () => {
    const controller = new AbortController();
    const callTool = vi.fn(async () => adaptTerminalCallToolResult({ content: [] }));
    const codeMode = new CodeModeManager({ timeoutMs: 5000 });
    initCodeMode(
      codeMode,
      [makeTool("schema_less_read", { annotations: { readOnlyHint: true } })],
      callTool,
    );

    await codeMode.executeCode("return await codemode.schema_less_read({});", controller.signal);

    expect(callTool).toHaveBeenCalledWith("fixture", "schema_less_read", {}, controller.signal);
  });
});

function makeTool(name: string, overrides: Partial<McpTool> = {}): McpTool {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    serverName: "fixture",
    ...overrides,
  };
}

function fakeManager(tools: McpTool[], callTool: ReturnType<typeof vi.fn>): McpClientManager {
  return mutableFakeManager(() => tools, callTool);
}

function mutableFakeManager(
  readTools: () => McpTool[],
  callTool: ReturnType<typeof vi.fn>,
): McpClientManager {
  return {
    getTools: () => readTools(),
    getConnectedServers: () => [...new Set(readTools().map((tool) => tool.serverName))],
    getToolsForServer: (name: string) => readTools().filter((tool) => tool.serverName === name),
    callTool,
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClientManager;
}

/** Wire a fake manager through the real policy, mirroring production wiring. */
function initCodeMode(
  codeMode: CodeModeManager,
  tools: McpTool[],
  callTool: ReturnType<typeof vi.fn>,
  approval?: boolean,
): McpPolicy {
  const manager = fakeManager(tools, callTool);
  const policy = new McpPolicy({
    gateway: manager,
    ...(approval === undefined ? {} : { approvals: { confirm: async () => approval } }),
  });
  codeMode.initialize(manager, policy);
  return policy;
}
