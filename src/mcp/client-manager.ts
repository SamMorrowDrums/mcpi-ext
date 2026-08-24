import {
  Client,
  StreamableHTTPClientTransport,
  type ReadResourceResult,
  type Resource,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { adaptTerminalCallToolResult, type TerminalCallToolResult } from "./call-tool-result.js";
import {
  createMcpClient,
  getMcpClientDiagnostics,
  MCP_CLIENT_POLICY,
  type CreateMcpClientOptions,
  type McpClientDiagnostics,
  type McpElicitationHandler,
} from "./client-factory.js";
import type { McpConfig, ServerConfig } from "./config.js";
import { McpHostElicitationError } from "./host-elicitation.js";

/** An MCP tool as discovered from a server. */
export interface McpTool {
  /** Tool name as reported by the server. */
  name: string;
  description?: string;
  /** Complete JSON Schema 2020-12 object for the tool's parameters. */
  inputSchema: Tool["inputSchema"];
  /** Complete JSON Schema 2020-12 object for structured output, if declared. */
  outputSchema?: Tool["outputSchema"];
  /** Tool annotations (readOnlyHint, destructiveHint, etc.). */
  annotations?: Tool["annotations"];
  /** Which configured server this tool came from. */
  serverName: string;
}

interface ManagedConnection {
  client: Client;
  transport: Transport;
  tools: McpTool[];
  diagnostics?: McpClientDiagnostics;
}

export interface McpClientManagerOptions {
  elicitation?: McpElicitationHandler;
  clientFactory?: (options: CreateMcpClientOptions) => Client;
  transportFactory?: (config: ServerConfig) => Transport;
}

const unavailableElicitation: McpElicitationHandler = {
  elicit: () =>
    Promise.reject(
      new McpHostElicitationError(
        "The MCP server requested user input, but no host elicitation integration is configured. The request was not approved.",
      ),
    ),
};

/**
 * Manages connections to multiple MCP servers and aggregates their tools.
 *
 * Tools are discovered and stored internally. They are NOT registered with mcpi
 * automatically — that responsibility belongs to the access tiers.
 */
export class McpClientManager {
  private readonly connections = new Map<string, ManagedConnection>();
  private readonly elicitation: McpElicitationHandler;
  private readonly clientFactory: (options: CreateMcpClientOptions) => Client;
  private readonly transportFactory: (config: ServerConfig) => Transport;

  constructor(options: McpClientManagerOptions = {}) {
    this.elicitation = options.elicitation ?? unavailableElicitation;
    this.clientFactory = options.clientFactory ?? createMcpClient;
    this.transportFactory = options.transportFactory ?? createTransport;
  }

  /**
   * Connect to all servers defined in the config.
   * Connections that fail are logged and skipped — partial success is fine.
   */
  async connectAll(config: McpConfig, log: (msg: string) => void = console.error): Promise<void> {
    const entries = Object.entries(config.mcpServers).sort(([left], [right]) =>
      compareStrings(left, right),
    );
    const results = await Promise.allSettled(
      entries.map(([name, serverConfig]) => this.connectOne(name, serverConfig, log)),
    );

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      if (result.status === "rejected") {
        log(`[mcp] Failed to connect to "${entries[index][0]}": ${formatError(result.reason)}`);
      }
    }
  }

  /** Connect to a single server by name. */
  async connectOne(
    name: string,
    serverConfig: ServerConfig,
    log: (msg: string) => void = console.error,
  ): Promise<void> {
    if (this.connections.has(name)) {
      await this.disconnectOne(name);
    }

    const transport = this.transportFactory(serverConfig);
    const client = this.clientFactory({
      elicitation: this.elicitation,
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) {
              log(`[mcp] Failed to refresh tools for "${name}": ${formatError(error)}`);
              return;
            }
            if (!tools) return;

            const connection = this.connections.get(name);
            if (connection?.client === client) {
              connection.tools = toMcpTools(name, tools);
              log(`[mcp] Tools updated for "${name}" (${connection.tools.length} tools)`);
            }
          },
        },
      },
    });

    this.connections.set(name, { client, transport, tools: [] });

    try {
      await client.connect(transport, {
        timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
        maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
      });

      const toolsResult = await client.listTools(undefined, {
        timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
        maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
      });
      const tools = toMcpTools(name, toolsResult.tools);
      const diagnostics = getMcpClientDiagnostics(client);
      const connection = this.connections.get(name);
      if (connection?.client === client) {
        connection.tools = tools;
        connection.diagnostics = diagnostics;
      }
      log(
        `[mcp] Connected to "${name}" (${tools.length} tools, protocol era: ${diagnostics.protocolEra ?? "unknown"})`,
      );
    } catch (error) {
      const connection = this.connections.get(name);
      if (connection?.client === client) {
        this.connections.delete(name);
      }
      try {
        await client.close();
      } catch {
        // Preserve the original connection failure.
      }
      throw error;
    }
  }

  /** Call a tool and return only its terminal protocol result. */
  async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TerminalCallToolResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await connection.client.callTool(
      { name: toolName, arguments: args },
      {
        timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
        maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
    return adaptTerminalCallToolResult(result);
  }

  /** List a server's resources. Discovery only; authorization lives in McpPolicy. */
  async listResources(serverName: string, signal?: AbortSignal): Promise<Resource[]> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await connection.client.listResources(undefined, {
      timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
      maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
      ...(signal ? { signal } : {}),
    });
    return [...result.resources].sort(compareResources);
  }

  /** Read a single resource. Authorization is the caller-side policy's responsibility. */
  async readResource(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<ReadResourceResult> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    return connection.client.readResource(
      { uri },
      {
        timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
        maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
        ...(signal ? { signal } : {}),
      },
    );
  }

  /** Disconnect a single server. */
  async disconnectOne(name: string): Promise<void> {
    const connection = this.connections.get(name);
    if (!connection) return;
    this.connections.delete(name);
    try {
      await connection.client.close();
    } catch {
      // The connection is already removed; shutdown is best-effort.
    }
  }

  /** Disconnect all servers. */
  async disconnectAll(): Promise<void> {
    const names = this.getConnectedServers();
    await Promise.allSettled(names.map((name) => this.disconnectOne(name)));
  }

  /** Get all discovered tools across all connected servers. */
  getTools(): McpTool[] {
    return [...this.connections.values()]
      .flatMap((connection) => connection.tools)
      .sort(compareTools);
  }

  /** Get tools from a specific server. */
  getToolsForServer(name: string): McpTool[] {
    return [...(this.connections.get(name)?.tools ?? [])].sort(compareTools);
  }

  /** Get the MCP Client for discovery APIs that are not tool calls. */
  getClient(name: string): Client | undefined {
    return this.connections.get(name)?.client;
  }

  getDiagnostics(name: string): McpClientDiagnostics | undefined {
    return this.connections.get(name)?.diagnostics;
  }

  /** List connected server names in deterministic order. */
  getConnectedServers(): string[] {
    return [...this.connections.keys()].sort(compareStrings);
  }
}

function createTransport(config: ServerConfig): Transport {
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

  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers ?? {},
    },
  });
}

function toMcpTools(serverName: string, tools: Tool[]): McpTool[] {
  return tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      serverName,
    }))
    .sort(compareTools);
}

function compareTools(left: McpTool, right: McpTool): number {
  return compareStrings(left.serverName, right.serverName) || compareStrings(left.name, right.name);
}

function compareResources(left: Resource, right: Resource): number {
  return compareStrings(left.uri, right.uri) || compareStrings(left.name, right.name);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
