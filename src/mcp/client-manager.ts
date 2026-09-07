import type { z } from "zod";
import {
  Client,
  StreamableHTTPClientTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplateType,
  type Tool,
  type Transport,
} from "@modelcontextprotocol/client";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import {
  DirectoryReadResultSchema,
  SkillsGetResultSchema,
  SkillsListResultSchema,
  type DirectoryReadResult,
  type SkillsGetResult,
  type SkillsListResult,
} from "../skills/sep2640/protocol.js";
import { describeNegotiation, SKILLS_METHODS } from "../skills/sep2640/spec.js";
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

/** A lossless MCP tool as discovered from a server, tagged with its origin. */
export type McpTool = Tool & {
  /** Which configured server this tool came from. */
  serverName: string;
};

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
  /**
   * Advertise the draft skills extension (SEP-2640) at initialize.
   *
   * Off by default; the host turns it on from config. When off, no connection
   * this manager opens mentions the extension at all.
   */
  skillsExtension?: boolean;
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
  private skillsExtensionRequested: boolean;

  constructor(options: McpClientManagerOptions = {}) {
    this.elicitation = options.elicitation ?? unavailableElicitation;
    this.clientFactory = options.clientFactory ?? createMcpClient;
    this.transportFactory = options.transportFactory ?? createTransport;
    this.skillsExtensionRequested = options.skillsExtension === true;
  }

  /** Whether this manager advertises the draft skills extension. */
  requestsSkillsExtension(): boolean {
    return this.skillsExtensionRequested;
  }

  /**
   * Turn the draft skills extension on or off for future connections.
   *
   * The host reads the gate from config, which loads after this manager is
   * constructed. Already-open connections keep whatever they negotiated at
   * initialize, because the capability set is fixed for a session.
   */
  enableSkillsExtension(enabled: boolean): void {
    this.skillsExtensionRequested = enabled;
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
      skillsExtension: this.skillsExtensionRequested,
      listChanged: {
        tools: {
          onChanged: (error, tools) => {
            if (error) {
              log(`[mcp] Failed to refresh tools for "${name}": ${formatError(error)}`);
              return;
            }
            if (tools === null) return;

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
      const diagnostics = getMcpClientDiagnostics(client, {
        skillsExtensionRequested: this.skillsExtensionRequested,
      });
      const connection = this.connections.get(name);
      if (connection?.client === client) {
        connection.tools = tools;
        connection.diagnostics = diagnostics;
      }
      log(
        `[mcp] Connected to "${name}" (${tools.length} tools, protocol era: ${diagnostics.protocolEra ?? "unknown"})`,
      );
      if (this.skillsExtensionRequested) {
        log(
          `[mcp] "${name}": ${describeNegotiation(name, diagnostics.skillsExtension.serverCapability)}`,
        );
      }
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
        ...(signal !== undefined ? { signal } : {}),
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
      ...(signal !== undefined ? { signal } : {}),
    });
    return [...result.resources].sort(compareResources);
  }

  /** List a server's resource templates. Authorization lives in McpPolicy. */
  async listResourceTemplates(
    serverName: string,
    signal?: AbortSignal,
  ): Promise<ResourceTemplateType[]> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    const result = await connection.client.listResourceTemplates(undefined, {
      timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
      maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
    return [...result.resourceTemplates].sort(compareResourceTemplates);
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
        ...(signal !== undefined ? { signal } : {}),
      },
    );
  }

  // ---------------------------------------------------------------------------
  // Draft SEP-2640 skills extension transport
  //
  // These are transport methods, not authorization. `McpPolicy` decides whether
  // a call may happen; this class only knows how to put it on the wire and how
  // to refuse to hand back a payload that does not match the draft schema.
  // ---------------------------------------------------------------------------

  /**
   * The settings a server declared for one extension during `initialize`, or
   * `undefined` if it declared no such extension.
   */
  getExtensionCapability(
    serverName: string,
    extensionName: string,
  ): Record<string, unknown> | undefined {
    const capability = this.connections.get(serverName)?.client.getServerCapabilities()
      ?.extensions?.[extensionName];
    if (capability === undefined) {
      return undefined;
    }
    if (capability === null || typeof capability !== "object" || Array.isArray(capability)) {
      // An extension declared with a non-object body is still "declared"; treat
      // it as declared-with-no-settings rather than inventing settings for it.
      return {};
    }
    return capability as Record<string, unknown>;
  }

  /** Draft SEP-2640 `skills/list`. */
  async requestSkillsList(
    serverName: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SkillsListResult> {
    return this.requestExtension(
      serverName,
      SKILLS_METHODS.list,
      cursor !== undefined ? { cursor } : {},
      SkillsListResultSchema,
      signal,
    );
  }

  /** Draft SEP-2640 `skills/get`. */
  async requestSkillsGet(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<SkillsGetResult> {
    return this.requestExtension(
      serverName,
      SKILLS_METHODS.get,
      { uri },
      SkillsGetResultSchema,
      signal,
    );
  }

  /** Draft SEP-2640 `resources/directory/read`. */
  async requestDirectoryRead(
    serverName: string,
    uri: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryReadResult> {
    return this.requestExtension(
      serverName,
      SKILLS_METHODS.directoryRead,
      cursor !== undefined ? { uri, cursor } : { uri },
      DirectoryReadResultSchema,
      signal,
    );
  }

  private async requestExtension<T>(
    serverName: string,
    method: string,
    params: Record<string, unknown>,
    schema: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server "${serverName}" is not connected`);
    }

    return connection.client.request({ method, params }, schema, {
      timeout: MCP_CLIENT_POLICY.requestTimeoutMs,
      maxTotalTimeout: MCP_CLIENT_POLICY.maxTotalTimeoutMs,
      ...(signal !== undefined ? { signal } : {}),
    });
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
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: buildStdioEnvironment(config.env),
      cwd: config.cwd,
    });
  }

  return new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: config.headers ?? {},
    },
  });
}

/** Build the SDK's safe child environment without leaking this or a parent bridge endpoint. */
export function buildStdioEnvironment(
  configured: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const environment = { ...getDefaultEnvironment(), ...configured };
  for (const name of Object.keys(environment)) {
    if (name.startsWith("TOOL_CLI_")) {
      Reflect.deleteProperty(environment, name);
    }
  }
  return environment;
}

function toMcpTools(serverName: string, tools: Tool[]): McpTool[] {
  return tools
    .map((tool) => ({
      ...tool,
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

function compareResourceTemplates(left: ResourceTemplateType, right: ResourceTemplateType): number {
  return (
    compareStrings(left.uriTemplate, right.uriTemplate) || compareStrings(left.name, right.name)
  );
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
