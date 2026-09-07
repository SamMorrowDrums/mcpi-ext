import type { CallToolResult, Client, Tool, Transport } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SKILLS_EXTENSION_REVISION } from "../skills/sep2640/spec.js";
import type { CreateMcpClientOptions } from "./client-factory.js";
import { buildStdioEnvironment, McpClientManager } from "./client-manager.js";

const nestedSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  $defs: {
    label: { type: "string", minLength: 2 },
  },
  properties: {
    name: { $ref: "#/$defs/label" },
  },
  allOf: [{ required: ["name"] }],
  unevaluatedProperties: false,
} as const;

const structuredValues: CallToolResult["structuredContent"][] = [
  false,
  0,
  "",
  null,
  [],
  { nested: ["value"] },
];

it("builds stdio environments from the SDK safe default without bridge credentials", () => {
  const previous = process.env.MCPI_EXT_UNSAFE_ENV_FIXTURE;
  process.env.MCPI_EXT_UNSAFE_ENV_FIXTURE = "inherited-secret";
  try {
    const environment = buildStdioEnvironment({
      MCP_FIXTURE: "visible",
      TOOL_CLI_HOST: "example.invalid",
      TOOL_CLI_PORT: "7179",
      TOOL_CLI_TOKEN: "bridge-secret",
    });

    expect(environment.MCP_FIXTURE).toBe("visible");
    expect(environment.MCPI_EXT_UNSAFE_ENV_FIXTURE).toBeUndefined();
    expect(Object.keys(environment).filter((name) => name.startsWith("TOOL_CLI_"))).toEqual([]);
  } finally {
    if (previous === undefined) {
      delete process.env.MCPI_EXT_UNSAFE_ENV_FIXTURE;
    } else {
      process.env.MCPI_EXT_UNSAFE_ENV_FIXTURE = previous;
    }
  }
});

describe("McpClientManager", () => {
  let clients: FakeClient[];
  let clientOptions: CreateMcpClientOptions[];
  let manager: McpClientManager;

  beforeEach(() => {
    clients = [];
    clientOptions = [];
    manager = new McpClientManager({
      clientFactory: (options) => {
        clientOptions.push(options);
        const client = new FakeClient();
        clients.push(client);
        return client as unknown as Client;
      },
      transportFactory: () => fakeTransport,
    });
  });

  it("aggregates complete schemas and orders servers and tools deterministically", async () => {
    await manager.connectAll({
      mcpServers: {
        zebra: { type: "stdio", command: "zebra" },
        alpha: { type: "remote", url: "https://example.com/mcp" },
      },
    });

    expect(manager.getConnectedServers()).toEqual(["alpha", "zebra"]);
    expect(manager.getTools().map((tool) => `${tool.serverName}/${tool.name}`)).toEqual([
      "alpha/a_tool",
      "alpha/z_tool",
      "zebra/a_tool",
      "zebra/z_tool",
    ]);
    expect(manager.getTools()[0].inputSchema).toEqual(nestedSchema);
    expect(manager.getTools()[0]).toMatchObject({
      name: "a_tool",
      title: "A tool",
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+" }],
      serverName: "alpha",
    });
  });

  it("records negotiated diagnostics from the client", async () => {
    await manager.connectOne("modern", { type: "stdio", command: "server" });

    expect(manager.getDiagnostics("modern")).toEqual({
      protocolVersion: "2026-07-28",
      protocolEra: "modern",
      discoverResult: {
        supportedVersions: ["2026-07-28"],
        capabilities: { tools: {} },
      },
      serverImplementation: { name: "fixture-server", version: "3.2.1" },
      serverCapabilities: { tools: { listChanged: true }, resources: {} },
      // The draft skills extension is opt-in, so an ordinary connection
      // reports it as neither requested nor declared.
      skillsExtension: {
        requested: false,
        revision: SKILLS_EXTENSION_REVISION,
        status: "draft",
        serverDeclared: false,
        serverCapability: undefined,
      },
    });
  });

  it.each(structuredValues)(
    "returns one terminal result without losing structured value %j",
    async (structuredContent) => {
      await manager.connectOne("server", { type: "stdio", command: "server" });
      const result: CallToolResult = {
        content: [
          { type: "text", text: "done" },
          { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        ],
        structuredContent,
        isError: true,
      };
      clients[0].callTool.mockResolvedValueOnce(result);

      const terminal = await manager.callTool("server", "z_tool", { value: 1 });

      expect(terminal).toEqual({ kind: "terminal", result });
      expect(terminal.result.structuredContent).toEqual(structuredContent);
      expect(clients[0].callTool).toHaveBeenCalledWith(
        { name: "z_tool", arguments: { value: 1 } },
        expect.objectContaining({ timeout: 60_000, maxTotalTimeout: 600_000 }),
      );
    },
  );

  it("keeps thrown protocol or transport failures distinct from terminal results", async () => {
    await manager.connectOne("server", { type: "stdio", command: "server" });
    clients[0].callTool.mockRejectedValueOnce(new Error("transport disconnected"));

    await expect(manager.callTool("server", "z_tool", {})).rejects.toThrow(
      "transport disconnected",
    );
  });

  it("forwards cancellation to MCP v2 tool calls", async () => {
    await manager.connectOne("server", { type: "stdio", command: "server" });
    const controller = new AbortController();
    clients[0].callTool.mockResolvedValueOnce({ content: [] });

    await manager.callTool("server", "z_tool", {}, controller.signal);

    expect(clients[0].callTool).toHaveBeenCalledWith(
      { name: "z_tool", arguments: {} },
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("preserves complete resource and template fields and forwards cancellation", async () => {
    await manager.connectOne("server", { type: "stdio", command: "server" });
    const controller = new AbortController();

    const resources = await manager.listResources("server", controller.signal);
    const templates = await manager.listResourceTemplates("server", controller.signal);
    const read = await manager.readResource("server", "file:///binary", controller.signal);

    expect(resources).toEqual([
      {
        uri: "file:///binary",
        name: "Binary",
        size: 3,
        annotations: { audience: ["assistant"], priority: 0 },
      },
    ]);
    expect(templates).toEqual([
      {
        uriTemplate: "file:///logs/{date}",
        name: "Log",
        customMetadata: { empty: "" },
      },
    ]);
    expect(read).toEqual({
      contents: [
        {
          uri: "file:///binary",
          mimeType: "application/octet-stream",
          blob: "AAEC",
          _meta: { falsey: false },
        },
      ],
      _meta: { page: 0 },
    });
    expect(clients[0].listResources).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(clients[0].listResourceTemplates).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ signal: controller.signal }),
    );
    expect(clients[0].readResource).toHaveBeenCalledWith(
      { uri: "file:///binary" },
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it("refreshes and sorts tools after a list_changed notification", async () => {
    await manager.connectOne("server", { type: "stdio", command: "server" });
    clientOptions[0].listChanged?.tools?.onChanged(null, [tool("later"), tool("earlier")]);

    expect(manager.getToolsForServer("server").map((entry) => entry.name)).toEqual([
      "earlier",
      "later",
    ]);
  });

  it("logs one failed connection while retaining successful connections", async () => {
    const logs: string[] = [];
    const failingManager = new McpClientManager({
      clientFactory: () => {
        const client = new FakeClient();
        if (clients.length === 0) {
          client.connect.mockRejectedValueOnce(new Error("connection refused"));
        }
        clients.push(client);
        return client as unknown as Client;
      },
      transportFactory: () => fakeTransport,
    });

    await failingManager.connectAll(
      {
        mcpServers: {
          failing: { type: "stdio", command: "bad" },
          working: { type: "stdio", command: "good" },
        },
      },
      (message) => logs.push(message),
    );

    expect(failingManager.getConnectedServers()).toEqual(["working"]);
    expect(logs).toContain('[mcp] Failed to connect to "failing": connection refused');
  });

  it("replaces and closes an existing connection with the same name", async () => {
    await manager.connectOne("server", { type: "stdio", command: "one" });
    await manager.connectOne("server", { type: "stdio", command: "two" });

    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(manager.getConnectedServers()).toEqual(["server"]);
  });
});

class FakeClient {
  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  callTool = vi.fn<() => Promise<CallToolResult>>();
  listTools = vi.fn(async () => ({
    tools: [
      tool("z_tool"),
      tool("a_tool", nestedSchema, {
        title: "A tool",
        outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+" }],
      }),
    ],
  }));
  listResources = vi.fn(async () => ({
    resources: [
      {
        uri: "file:///binary",
        name: "Binary",
        size: 3,
        annotations: { audience: ["assistant"], priority: 0 },
      },
    ],
  }));
  listResourceTemplates = vi.fn(async () => ({
    resourceTemplates: [
      {
        uriTemplate: "file:///logs/{date}",
        name: "Log",
        customMetadata: { empty: "" },
      },
    ],
  }));
  readResource = vi.fn(async () => ({
    contents: [
      {
        uri: "file:///binary",
        mimeType: "application/octet-stream",
        blob: "AAEC",
        _meta: { falsey: false },
      },
    ],
    _meta: { page: 0 },
  }));

  getProtocolEra(): "modern" {
    return "modern";
  }

  getDiscoverResult() {
    return {
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    };
  }

  getNegotiatedProtocolVersion(): string {
    return "2026-07-28";
  }

  getServerVersion() {
    return { name: "fixture-server", version: "3.2.1" };
  }

  getServerCapabilities() {
    return { tools: { listChanged: true }, resources: {} };
  }
}

function tool(
  name: string,
  inputSchema: Tool["inputSchema"] = { type: "object" },
  overrides: Partial<Tool> = {},
): Tool {
  return {
    name,
    inputSchema,
    annotations: { readOnlyHint: true },
    ...overrides,
  };
}

const fakeTransport: Transport = {
  start: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};
