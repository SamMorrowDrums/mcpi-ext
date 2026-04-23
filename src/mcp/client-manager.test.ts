import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpClientManager } from "./client-manager.js";

// Mock the MCP SDK transports and client
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => {
  class MockClient {
    private _onToolsChanged?: (error: Error | null, tools: unknown[] | null) => void;

    constructor(
      _info: unknown,
      options?: {
        listChanged?: {
          tools?: { onChanged?: (error: Error | null, tools: unknown[] | null) => void };
        };
      },
    ) {
      this._onToolsChanged = options?.listChanged?.tools?.onChanged;
    }
    async connect(_transport: unknown): Promise<void> {
      // no-op for tests
    }
    async close(): Promise<void> {
      // no-op for tests
    }
    async listTools(): Promise<{ tools: unknown[] }> {
      return {
        tools: [
          {
            name: "mock_tool",
            description: "A mock tool for testing",
            inputSchema: { type: "object", properties: { arg: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
          {
            name: "mock_tool_2",
            description: "Another mock tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      };
    }

    /** Test helper to simulate tools/list_changed notification. */
    _simulateToolsChanged(tools: unknown[]): void {
      this._onToolsChanged?.(null, tools);
    }
  }
  return { Client: MockClient };
});

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  StdioClientTransport: class {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_params: unknown) {
      // no-op mock
    }
  },
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  StreamableHTTPClientTransport: class {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor(_url: URL, _opts?: unknown) {
      // no-op mock
    }
  },
}));

describe("McpClientManager", () => {
  let manager: McpClientManager;

  beforeEach(() => {
    manager = new McpClientManager();
  });

  it("connects to a stdio server and discovers tools", async () => {
    await manager.connectAll({
      mcpServers: {
        "test-stdio": {
          type: "stdio",
          command: "node",
          args: ["test-server.js"],
        },
      },
    });

    expect(manager.getConnectedServers()).toEqual(["test-stdio"]);

    const tools = manager.getTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe("mock_tool");
    expect(tools[0].serverName).toBe("test-stdio");
    expect(tools[0].description).toBe("A mock tool for testing");
    expect(tools[0].annotations).toEqual({ readOnlyHint: true });
    expect(tools[1].name).toBe("mock_tool_2");
  });

  it("connects to a remote server and discovers tools", async () => {
    await manager.connectAll({
      mcpServers: {
        "test-remote": {
          type: "remote",
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer test" },
        },
      },
    });

    expect(manager.getConnectedServers()).toEqual(["test-remote"]);
    expect(manager.getTools()).toHaveLength(2);
  });

  it("connects to multiple servers and aggregates tools", async () => {
    await manager.connectAll({
      mcpServers: {
        server1: { type: "stdio", command: "node", args: ["s1.js"] },
        server2: { type: "remote", url: "https://example.com/mcp" },
      },
    });

    expect(manager.getConnectedServers()).toHaveLength(2);
    // 2 tools per server
    expect(manager.getTools()).toHaveLength(4);
  });

  it("getToolsForServer returns tools for a specific server", async () => {
    await manager.connectAll({
      mcpServers: {
        srv: { type: "stdio", command: "echo" },
      },
    });

    expect(manager.getToolsForServer("srv")).toHaveLength(2);
    expect(manager.getToolsForServer("nonexistent")).toEqual([]);
  });

  it("getClient returns the client for a connected server", async () => {
    await manager.connectAll({
      mcpServers: {
        srv: { type: "stdio", command: "echo" },
      },
    });

    expect(manager.getClient("srv")).toBeDefined();
    expect(manager.getClient("nonexistent")).toBeUndefined();
  });

  it("disconnectOne removes a server", async () => {
    await manager.connectAll({
      mcpServers: {
        srv: { type: "stdio", command: "echo" },
      },
    });

    expect(manager.getConnectedServers()).toEqual(["srv"]);
    await manager.disconnectOne("srv");
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
  });

  it("disconnectAll removes all servers", async () => {
    await manager.connectAll({
      mcpServers: {
        s1: { type: "stdio", command: "echo" },
        s2: { type: "remote", url: "https://example.com/mcp" },
      },
    });

    expect(manager.getConnectedServers()).toHaveLength(2);
    await manager.disconnectAll();
    expect(manager.getConnectedServers()).toEqual([]);
  });

  it("handles empty config gracefully", async () => {
    await manager.connectAll({ mcpServers: {} });
    expect(manager.getConnectedServers()).toEqual([]);
    expect(manager.getTools()).toEqual([]);
  });

  it("reconnects when connecting to an already-connected server name", async () => {
    await manager.connectOne("srv", { type: "stdio", command: "node" });
    expect(manager.getConnectedServers()).toEqual(["srv"]);

    // Connect again with same name — should replace
    await manager.connectOne("srv", { type: "remote", url: "https://example.com/mcp" });
    expect(manager.getConnectedServers()).toEqual(["srv"]);
    expect(manager.getTools()).toHaveLength(2);
  });

  it("logs failures but continues connecting other servers", async () => {
    const logs: string[] = [];
    // Patch Client.connect to fail for a specific transport
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const origConnect = Client.prototype.connect;
    let callCount = 0;
    Client.prototype.connect = async function (transport: unknown) {
      callCount++;
      if (callCount === 1) throw new Error("Connection refused");
      return origConnect.call(this, transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport);
    };

    try {
      await manager.connectAll(
        {
          mcpServers: {
            failing: { type: "stdio", command: "bad-command" },
            working: { type: "stdio", command: "good-command" },
          },
        },
        (msg) => logs.push(msg),
      );

      // The working server should still be connected
      expect(manager.getConnectedServers()).toContain("working");
      expect(logs.some((l) => l.includes("Failed to connect") && l.includes("failing"))).toBe(true);
    } finally {
      Client.prototype.connect = origConnect;
    }
  });
});
