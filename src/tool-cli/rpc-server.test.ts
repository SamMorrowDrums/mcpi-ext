import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { ToolCliRpcServer } from "./rpc-server.js";
import type { McpClientManager } from "../mcp/index.js";

/** Minimal mock of McpClientManager for RPC server testing. */
function createMockManager(): McpClientManager {
  const tools = [
    {
      name: "get_weather",
      description: "Get current weather for a city",
      inputSchema: {
        type: "object",
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
      annotations: { readOnlyHint: true },
      serverName: "weather",
    },
    {
      name: "set_alarm",
      description: "Set a weather alarm",
      inputSchema: {
        type: "object",
        properties: {
          city: { type: "string" },
          threshold: { type: "number" },
        },
        required: ["city", "threshold"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      serverName: "weather",
    },
    {
      name: "search_docs",
      description: "Search documentation",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", description: "Search query" } },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: { results: { type: "array" } },
      },
      annotations: { readOnlyHint: true },
      serverName: "docs",
    },
  ];

  return {
    getConnectedServers: () => ["weather", "docs"],
    getToolsForServer: (name: string) => tools.filter((t) => t.serverName === name),
    getTools: () => tools,
    getClient: (name: string) => {
      if (name === "weather" || name === "docs") {
        return {
          callTool: async (params: { name: string; arguments?: Record<string, unknown> }) => ({
            content: [{ type: "text", text: `Called ${params.name}` }],
          }),
        };
      }
      return undefined;
    },
  } as unknown as McpClientManager;
}

// Use port 0 so the OS assigns a free port — avoids collisions when src + dist tests run together
describe("ToolCliRpcServer", () => {
  let server: ToolCliRpcServer;
  let port: number;

  beforeAll(async () => {
    const manager = createMockManager();
    server = new ToolCliRpcServer(manager, 0);
    await server.start();
    port = server.getPort();
  });

  afterAll(async () => {
    await server.stop();
  });

  async function rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }),
    });
    return res.json();
  }

  it("lists connected servers with tool counts", async () => {
    const resp = (await rpc("listServers")) as {
      result: { servers: { name: string; toolCount: number; examples: string[] }[] };
    };
    const { servers } = resp.result;
    expect(servers).toHaveLength(2);

    const weather = servers.find((s) => s.name === "weather");
    expect(weather).toBeDefined();
    expect(weather?.toolCount).toBe(2);
    expect(weather?.examples.length).toBeGreaterThan(0);

    const docs = servers.find((s) => s.name === "docs");
    expect(docs).toBeDefined();
    expect(docs?.toolCount).toBe(1);
  });

  it("lists tools for a specific server", async () => {
    const resp = (await rpc("listTools", { server: "weather" })) as {
      result: { server: string; tools: { name: string; description: string }[] };
    };
    expect(resp.result.server).toBe("weather");
    expect(resp.result.tools).toHaveLength(2);
    expect(resp.result.tools[0].name).toBe("get_weather");
    expect(resp.result.tools[1].name).toBe("set_alarm");
  });

  it("describes a tool with full schema", async () => {
    const resp = (await rpc("describeTool", { server: "weather", tool: "get_weather" })) as {
      result: {
        name: string;
        description: string;
        inputSchema: Record<string, unknown>;
        annotations: Record<string, unknown>;
      };
    };
    expect(resp.result.name).toBe("get_weather");
    expect(resp.result.description).toBe("Get current weather for a city");
    expect(resp.result.inputSchema).toHaveProperty("properties");
    expect(resp.result.annotations).toEqual({ readOnlyHint: true });
  });

  it("calls a tool and returns result", async () => {
    const resp = (await rpc("callTool", {
      server: "weather",
      tool: "get_weather",
      arguments: { city: "London" },
    })) as {
      result: { content: { type: string; text: string }[] };
    };
    expect(resp.result.content).toHaveLength(1);
    expect(resp.result.content[0].text).toBe("Called get_weather");
  });

  it("returns error for unknown server", async () => {
    const resp = (await rpc("listTools", { server: "nonexistent" })) as {
      error: { code: number; message: string };
    };
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32602);
    expect(resp.error.message).toContain("not found");
  });

  it("returns error for unknown tool", async () => {
    const resp = (await rpc("describeTool", { server: "weather", tool: "nonexistent" })) as {
      error: { code: number; message: string };
    };
    expect(resp.error).toBeDefined();
    expect(resp.error.message).toContain("not found");
  });

  it("returns error for unknown method", async () => {
    const resp = (await rpc("unknownMethod")) as {
      error: { code: number; message: string };
    };
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32601);
  });

  it("returns error for missing required params", async () => {
    const resp = (await rpc("listTools", {})) as {
      error: { code: number; message: string };
    };
    expect(resp.error).toBeDefined();
    expect(resp.error.code).toBe(-32602);
  });

  it("rejects non-POST requests", async () => {
    const res = await fetch(`http://127.0.0.1:${port}`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("handles malformed JSON gracefully", async () => {
    const res = await fetch(`http://127.0.0.1:${port}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json at all",
    });
    const json = (await res.json()) as { error: { code: number } };
    expect(json.error.code).toBe(-32700);
  });
});
