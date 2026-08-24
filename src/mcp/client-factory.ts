import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
  type DiscoverResult,
  type ElicitRequestParams,
  type ElicitResult,
  type ListChangedHandlers,
  type ProtocolEra,
} from "@modelcontextprotocol/client";

export const MCP_CLIENT_IDENTITY = {
  name: "@sammorrowdrums/mcpi-ext",
  version: "0.2.1",
} as const;

export const MCP_CLIENT_POLICY = {
  listMaxPages: 64,
  maxInputRequiredRounds: 4,
  probeTimeoutMs: 5_000,
  requestTimeoutMs: 60_000,
  maxTotalTimeoutMs: 10 * 60_000,
} as const;

export const MCP_SUPPORTED_PROTOCOL_VERSIONS = [
  "2026-07-28",
  ...SUPPORTED_PROTOCOL_VERSIONS,
] as const;

export interface McpElicitationHandler {
  elicit(params: ElicitRequestParams): Promise<ElicitResult>;
}

export interface McpClientDiagnostics {
  protocolEra: ProtocolEra | undefined;
  discoverResult: DiscoverResult | undefined;
}

export interface CreateMcpClientOptions {
  elicitation: McpElicitationHandler;
  listChanged?: ListChangedHandlers;
}

/**
 * Creates every MCP client with the same identity, negotiated protocol policy,
 * capabilities, pagination limit, and SDK-managed input_required handling.
 */
export function createMcpClient(options: CreateMcpClientOptions): Client {
  const client = new Client(MCP_CLIENT_IDENTITY, {
    supportedProtocolVersions: [...MCP_SUPPORTED_PROTOCOL_VERSIONS],
    capabilities: {
      elicitation: { form: {} },
      extensions: {},
    },
    versionNegotiation: {
      mode: "auto",
      probe: {
        timeoutMs: MCP_CLIENT_POLICY.probeTimeoutMs,
        maxRetries: 0,
      },
    },
    inputRequired: {
      autoFulfill: true,
      maxRounds: MCP_CLIENT_POLICY.maxInputRequiredRounds,
    },
    listChanged: options.listChanged,
    listMaxPages: MCP_CLIENT_POLICY.listMaxPages,
    defaultCacheTtlMs: 0,
  });

  client.setRequestHandler("elicitation/create", (request) =>
    options.elicitation.elicit(request.params),
  );

  return client;
}

export function getMcpClientDiagnostics(client: Client): McpClientDiagnostics {
  return {
    protocolEra: client.getProtocolEra(),
    discoverResult: client.getDiscoverResult(),
  };
}
