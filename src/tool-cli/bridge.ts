import {
  BRIDGE_PROTOCOL_MAJOR,
  BRIDGE_PROTOCOL_NAME,
  BRIDGE_RPC_OPERATIONS,
  BridgeCompatibilityError,
  PORT_ENV_VAR,
  RpcAbortError,
  RpcHttpError,
  RpcInvalidResponseError,
  RpcNonJsonResponseError,
  RpcProtocolError,
  RpcTimeoutError,
  RpcTransportError,
  TOKEN_ENV_VAR,
  getBridgeInfo,
  type BridgeInfo,
} from "@sammorrowdrums/tool-cli/client";

const HANDSHAKE_TIMEOUT_MS = 5_000;
export const TOOL_CLI_HOST_ENV_VAR = "TOOL_CLI_HOST";
export const TOOL_CLI_LOCAL_HOST = "127.0.0.1";
const REQUIRED_JSON_SCHEMA_DIALECTS = [
  "https://json-schema.org/draft/2020-12/schema",
  "https://json-schema.org/draft/2019-09/schema",
  "http://json-schema.org/draft-07/schema#",
] as const;
let handshakeEnvironmentTail: Promise<void> = Promise.resolve();

export interface ToolCliBridgeEndpoint {
  port: number;
  token: string;
}

/**
 * Authenticate to the newly started bridge and verify the complete v1 surface
 * before exposing its endpoint to agent-spawned shell commands.
 */
export async function verifyToolCliBridge(
  endpoint: ToolCliBridgeEndpoint,
  timeoutMs: number = HANDSHAKE_TIMEOUT_MS,
): Promise<BridgeInfo> {
  return withExclusiveClientEnvironment(endpoint, async () => {
    const info = await getBridgeInfo({ timeoutMs });
    assertRequiredV1Surface(info);
    return info;
  });
}

async function withExclusiveClientEnvironment<T>(
  endpoint: ToolCliBridgeEndpoint,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = handshakeEnvironmentTail;
  let release!: () => void;
  handshakeEnvironmentTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;

  let restore: (() => void) | undefined;
  try {
    restore = installTemporaryClientEnvironment(endpoint);
    return await operation();
  } finally {
    restore?.();
    release();
  }
}

export function formatToolCliBridgeError(error: unknown): string {
  if (error instanceof BridgeCompatibilityError) {
    return `Tool-cli bridge compatibility error: ${error.message}. Install matching tool-cli and mcpi-ext major versions.`;
  }
  if (error instanceof RpcTimeoutError) {
    return `Tool-cli bridge handshake timed out after ${error.timeoutMs}ms. Check bridge responsiveness and version compatibility.`;
  }
  if (error instanceof RpcHttpError) {
    const auth =
      error.status === 401
        ? " The bridge rejected the bearer token; restart the bridge to obtain fresh credentials."
        : "";
    return `Tool-cli bridge ${error.message}.${auth}`;
  }
  if (error instanceof RpcProtocolError) {
    return `Tool-cli bridge RPC ${error.code}: ${error.message}${formatErrorData(error.data)}`;
  }
  if (error instanceof RpcNonJsonResponseError) {
    return `Tool-cli bridge returned non-JSON HTTP ${error.status}: ${error.message}`;
  }
  if (error instanceof RpcInvalidResponseError) {
    return `Tool-cli bridge returned an invalid JSON-RPC response: ${error.message}`;
  }
  if (error instanceof RpcAbortError) {
    return `Tool-cli bridge handshake was cancelled${formatErrorData(error.reason)}`;
  }
  if (error instanceof RpcTransportError) {
    return `Tool-cli bridge transport error: ${error.message}. Confirm the local bridge is listening and reachable.`;
  }
  return error instanceof Error ? error.message : String(error);
}

export function isToolCliCompatibilityError(error: unknown): boolean {
  return error instanceof BridgeCompatibilityError;
}

function assertRequiredV1Surface(info: BridgeInfo): void {
  const value: unknown = info;
  const root = requireRecord(value, "bridge metadata", value);
  const protocol = requireRecord(root.bridgeProtocol, "bridgeProtocol metadata", value);
  if (
    protocol.name !== BRIDGE_PROTOCOL_NAME ||
    protocol.major !== BRIDGE_PROTOCOL_MAJOR ||
    typeof protocol.version !== "string" ||
    protocol.version.length === 0 ||
    Number(protocol.version.split(".", 1)[0]) !== BRIDGE_PROTOCOL_MAJOR
  ) {
    throw new BridgeCompatibilityError(
      `tool-cli bridge did not report a valid ${BRIDGE_PROTOCOL_NAME} v${BRIDGE_PROTOCOL_MAJOR} protocol version`,
      value,
    );
  }

  const implementation = requireRecord(
    root.serverImplementation,
    "serverImplementation metadata",
    value,
  );
  if (
    typeof implementation.name !== "string" ||
    implementation.name.length === 0 ||
    typeof implementation.version !== "string" ||
    implementation.version.length === 0
  ) {
    throw new BridgeCompatibilityError(
      "tool-cli bridge did not report a valid implementation name and version",
      value,
    );
  }

  if (!isStringArray(root.operations) || new Set(root.operations).size !== root.operations.length) {
    throw new BridgeCompatibilityError(
      "tool-cli bridge did not report a valid deterministic operation list",
      value,
    );
  }
  const operations = root.operations;
  const missingOperations = BRIDGE_RPC_OPERATIONS.filter(
    (operation) => !operations.includes(operation),
  );
  if (missingOperations.length > 0) {
    throw new BridgeCompatibilityError(
      `tool-cli bridge v1 is missing required operation(s): ${missingOperations.join(", ")}`,
      value,
    );
  }
  const operationOrder = BRIDGE_RPC_OPERATIONS.map((operation) => operations.indexOf(operation));
  if (
    operationOrder.some((index, position) => position > 0 && index < operationOrder[position - 1])
  ) {
    throw new BridgeCompatibilityError(
      "tool-cli bridge v1 reported required operations in a non-deterministic order",
      value,
    );
  }

  const capabilities = requireRecord(root.capabilities, "capabilities metadata", value);
  const authentication = requireRecord(
    capabilities.authentication,
    "authentication capabilities",
    value,
  );
  const tools = requireRecord(capabilities.tools, "tool capabilities", value);
  const resources = requireRecord(capabilities.resources, "resource capabilities", value);
  const cancellation = requireRecord(capabilities.cancellation, "cancellation capabilities", value);
  const supportedDialects = tools.supportedJsonSchemaDialects;
  const missingCapabilities = [
    authentication.required !== true || authentication.scheme !== "bearer"
      ? "bearer authentication"
      : undefined,
    tools.discovery !== true ? "tool discovery" : undefined,
    tools.calls !== true ? "tool calls" : undefined,
    tools.inputSchemaValidation !== true ? "input schema validation" : undefined,
    tools.jsonSchemaDialect !== REQUIRED_JSON_SCHEMA_DIALECTS[0]
      ? "JSON Schema 2020-12 default dialect"
      : undefined,
    !isStringArray(supportedDialects) ||
    REQUIRED_JSON_SCHEMA_DIALECTS.some((dialect) => !supportedDialects.includes(dialect))
      ? "supported JSON Schema dialects"
      : undefined,
    resources.list !== true ? "resource listing" : undefined,
    resources.templates !== true ? "resource template listing" : undefined,
    resources.read !== true ? "resource reads" : undefined,
    cancellation.providerAbortSignal !== true ? "provider cancellation" : undefined,
  ].filter((capability): capability is string => capability !== undefined);

  if (missingCapabilities.length > 0) {
    throw new BridgeCompatibilityError(
      `tool-cli bridge v1 is missing required capability(s): ${missingCapabilities.join(", ")}`,
      value,
    );
  }
  if (!isRecord(root.upstreamMcp)) {
    throw new BridgeCompatibilityError(
      "tool-cli bridge did not report the required upstream MCP diagnostics summary",
      value,
    );
  }
  const upstream = root.upstreamMcp;
  if (
    !isNonNegativeInteger(upstream.serverCount) ||
    !Array.isArray(upstream.servers) ||
    upstream.servers.length !== upstream.serverCount
  ) {
    throw new BridgeCompatibilityError(
      "tool-cli bridge reported an invalid upstream MCP server summary",
      value,
    );
  }
  let previousServerName: string | undefined;
  for (const server of upstream.servers) {
    const entry = requireRecord(server, "upstream MCP server diagnostics", value);
    if (
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      !isNonNegativeInteger(entry.toolCount) ||
      (previousServerName !== undefined && entry.name <= previousServerName)
    ) {
      throw new BridgeCompatibilityError(
        "tool-cli bridge reported invalid or non-deterministic upstream MCP server diagnostics",
        value,
      );
    }
    previousServerName = entry.name;
  }
}

function requireRecord(
  value: unknown,
  description: string,
  bridgeInfo: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new BridgeCompatibilityError(
      `tool-cli bridge did not report valid ${description}`,
      bridgeInfo,
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function installTemporaryClientEnvironment(endpoint: ToolCliBridgeEndpoint): () => void {
  const previousPort = process.env[PORT_ENV_VAR];
  const previousToken = process.env[TOKEN_ENV_VAR];
  const previousHost = process.env[TOOL_CLI_HOST_ENV_VAR];
  process.env[PORT_ENV_VAR] = String(endpoint.port);
  process.env[TOKEN_ENV_VAR] = endpoint.token;
  process.env[TOOL_CLI_HOST_ENV_VAR] = TOOL_CLI_LOCAL_HOST;

  return () => {
    restoreEnvironment(PORT_ENV_VAR, previousPort);
    restoreEnvironment(TOKEN_ENV_VAR, previousToken);
    restoreEnvironment(TOOL_CLI_HOST_ENV_VAR, previousHost);
  };
}

function restoreEnvironment(name: string, previous: string | undefined): void {
  if (previous !== undefined) {
    process.env[name] = previous;
  } else {
    Reflect.deleteProperty(process.env, name);
  }
}

function formatErrorData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return ` (${JSON.stringify(data)})`;
  } catch {
    return ` (${String(data)})`;
  }
}
