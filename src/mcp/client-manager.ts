import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpConfig, ServerConfig } from "./config.js";

/** An MCP tool as discovered from a server. */
export interface McpTool {
  /** Tool name as reported by the server. */
  name: string;
  description?: string;
  /** JSON Schema for the tool's parameters. */
  inputSchema: Record<string, unknown>;
  /** JSON Schema for structured output, if declared. */
  outputSchema?: Record<string, unknown>;
  /** Tool annotations (readOnlyHint, destructiveHint, etc.). */
  annotations?: Record<string, unknown>;
  /** Which configured server this tool came from. */
  serverName: string;
}

interface ManagedConnection {
  client: Client;
  transport: StdioClientTransport | StreamableHTTPClientTransport;
  tools: McpTool[];
}

/**
 * Manages connections to multiple MCP servers and aggregates their tools.
 *
 * Tools are discovered and stored internally. They are NOT registered with pi
 * automatically — that responsibility belongs to the access tiers (Skills,
 * Football, Code Mode).
 */
export class McpClientManager {
  private connections = new Map<string, ManagedConnection>();

  /**
   * Connect to all servers defined in the config.
   * Connections that fail are logged and skipped — partial success is fine.
   */
  async connectAll(config: McpConfig, log: (msg: string) => void = console.error): Promise<void> {
    const entries = Object.entries(config.mcpServers);
    const results = await Promise.allSettled(
      entries.map(([name, serverConfig]) => this.connectOne(name, serverConfig, log)),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === "rejected") {
        log(`[mcp] Failed to connect to "${entries[i][0]}": ${result.reason}`);
      }
    }
  }

  /** Connect to a single server by name. */
  async connectOne(
    name: string,
    serverConfig: ServerConfig,
    log: (msg: string) => void = console.error,
  ): Promise<void> {
    // Disconnect existing connection with this name if any
    if (this.connections.has(name)) {
      await this.disconnectOne(name);
    }

    const transport = createTransport(serverConfig);

    const client = new Client(
      { name: "pi-mcp-agent", version: "0.1.0" },
      {
        capabilities: {},
        listChanged: {
          tools: {
            onChanged: (_error, tools) => {
              if (tools) {
                const conn = this.connections.get(name);
                if (conn) {
                  conn.tools = toMcpTools(name, tools);
                  log(`[mcp] Tools updated for "${name}" (${conn.tools.length} tools)`);
                }
              }
            },
          },
        },
      },
    );

    await client.connect(transport);

    const toolsResult = await client.listTools();
    const tools = toMcpTools(name, toolsResult.tools);
    log(`[mcp] Connected to "${name}" (${tools.length} tools)`);

    this.connections.set(name, { client, transport, tools });
  }

  /** Disconnect a single server. */
  async disconnectOne(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    this.connections.delete(name);
    try {
      await conn.client.close();
    } catch {
      // best-effort
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    const names = [...this.connections.keys()];
    await Promise.allSettled(names.map((n) => this.disconnectOne(n)));
  }

  /** Get all discovered tools across all connected servers. */
  getTools(): McpTool[] {
    const tools: McpTool[] = [];
    for (const conn of this.connections.values()) {
      tools.push(...conn.tools);
    }
    return tools;
  }

  /** Get tools from a specific server. */
  getToolsForServer(name: string): McpTool[] {
    return this.connections.get(name)?.tools ?? [];
  }

  /** Get the MCP Client for a specific server (needed to call tools). */
  getClient(name: string): Client | undefined {
    return this.connections.get(name)?.client;
  }

  /** List connected server names. */
  getConnectedServers(): string[] {
    return [...this.connections.keys()];
  }
}

function createTransport(
  config: ServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.type === "stdio") {
    const env = config.env
      ? Object.fromEntries(
          Object.entries({ ...process.env, ...config.env }).filter(
            (entry): entry is [string, string] => entry[1] !== undefined,
          ),
        )
      : undefined;
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env,
      cwd: config.cwd,
    });
  }

  const headers: Record<string, string> = {
    ...(config.headers ?? {}),
  };

  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers,
    },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toMcpTools(serverName: string, tools: any[]): McpTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
    outputSchema: t.outputSchema as Record<string, unknown> | undefined,
    annotations: t.annotations as Record<string, unknown> | undefined,
    serverName,
  }));
}
