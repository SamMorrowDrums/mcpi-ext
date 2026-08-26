import {
  Client,
  SUPPORTED_PROTOCOL_VERSIONS,
  type DiscoverResult,
  type ElicitRequestParams,
  type ElicitResult,
  type Implementation,
  type ListChangedHandlers,
  type ProtocolEra,
  type ServerCapabilities,
} from "@modelcontextprotocol/client";
import {
  SKILLS_EXTENSION_NAME,
  SKILLS_EXTENSION_REVISION,
  SKILLS_EXTENSION_STATUS,
} from "../skills/sep2640/spec.js";

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
  protocolVersion: string | undefined;
  protocolEra: ProtocolEra | undefined;
  discoverResult: DiscoverResult | undefined;
  serverImplementation: Implementation | undefined;
  serverCapabilities: ServerCapabilities | undefined;
  /**
   * What this client requested and what the server declared for the draft
   * skills extension, so a draft feature is never silently in play.
   */
  skillsExtension: {
    /** Whether this client advertised the extension at initialize. */
    requested: boolean;
    /** Pinned draft revision this implementation targets. */
    revision: string;
    /** Always `"draft"` — this is an unratified proposal. */
    status: string;
    /** Whether the server declared the extension back. */
    serverDeclared: boolean;
    /** Settings the server declared, or `undefined` if it declared none. */
    serverCapability: Record<string, unknown> | undefined;
  };
}

export interface CreateMcpClientOptions {
  elicitation: McpElicitationHandler;
  listChanged?: ListChangedHandlers;
  /**
   * Advertise the draft skills extension at initialize.
   *
   * Off by default. When false this client never mentions SEP-2640 on the
   * wire, which is what makes the fallback path a genuine absence of the
   * extension rather than a suppressed one.
   */
  skillsExtension?: boolean;
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
      // Per SEP-2133 the extension is offered here, at initialize, and the
      // server answers with its own settings. Every later skills request
      // re-reads that answer instead of trusting a cached yes.
      extensions: options.skillsExtension ? { [SKILLS_EXTENSION_NAME]: {} } : {},
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

export function getMcpClientDiagnostics(
  client: Client,
  options: { skillsExtensionRequested?: boolean } = {},
): McpClientDiagnostics {
  // Diagnostics run inside `connectOne`, so this must never be able to fail a
  // connection. `getServerCapabilities` is absent on minimal client doubles and
  // returns undefined before initialize completes; either way an unavailable
  // capability is reported as "not declared", never thrown.
  const serverCapabilities =
    typeof client.getServerCapabilities === "function" ? client.getServerCapabilities() : undefined;
  const declared = serverCapabilities?.extensions?.[SKILLS_EXTENSION_NAME];
  const capability =
    declared !== undefined && declared !== null && typeof declared === "object"
      ? (declared as Record<string, unknown>)
      : undefined;
  return {
    protocolVersion:
      typeof client.getNegotiatedProtocolVersion === "function"
        ? client.getNegotiatedProtocolVersion()
        : undefined,
    protocolEra: client.getProtocolEra(),
    discoverResult: client.getDiscoverResult(),
    serverImplementation:
      typeof client.getServerVersion === "function" ? client.getServerVersion() : undefined,
    serverCapabilities,
    skillsExtension: {
      requested: options.skillsExtensionRequested === true,
      revision: SKILLS_EXTENSION_REVISION,
      status: SKILLS_EXTENSION_STATUS,
      serverDeclared: capability !== undefined,
      serverCapability: capability,
    },
  };
}
