import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";
import { PORT_ENV_VAR, TOKEN_ENV_VAR } from "@sammorrowdrums/tool-cli/client";
import type { BashState, ToolCliState } from "../routing/facilities.js";
import {
  formatToolCliBridgeError,
  isToolCliCompatibilityError,
  TOOL_CLI_HOST_ENV_VAR,
  TOOL_CLI_LOCAL_HOST,
  verifyToolCliBridge,
  type ToolCliBridgeEndpoint,
} from "./bridge.js";

export interface ToolCliBridgeServer {
  start(log?: (message: string) => void): Promise<ToolCliBridgeEndpoint>;
  stop(): Promise<void>;
}

export interface ToolCliEnvironment {
  setEnv(name: string, value: string): void;
  unsetEnv(name: string): void;
}

export interface StartToolCliBridgeOptions {
  bash: BashState;
  server: ToolCliBridgeServer;
  environment: ToolCliEnvironment;
  log: (message: string) => void;
  verify?: (endpoint: ToolCliBridgeEndpoint) => Promise<BridgeInfo>;
}

/** Mask inherited credentials until this session has verified its own bridge endpoint. */
export function withholdToolCliCredentials(environment: ToolCliEnvironment): void {
  environment.setEnv(TOOL_CLI_HOST_ENV_VAR, TOOL_CLI_LOCAL_HOST);
  environment.setEnv(PORT_ENV_VAR, "");
  environment.setEnv(TOKEN_ENV_VAR, "");
}

/** Start, authenticate, and expose tool-cli only when both bridge and bash are usable. */
export async function startToolCliBridge(
  options: StartToolCliBridgeOptions,
): Promise<ToolCliState> {
  const { bash, environment, log, server } = options;
  withholdToolCliCredentials(environment);

  if (bash.kind !== "registered") {
    const reason =
      bash.kind === "absent"
        ? "no host bash tool is active"
        : `the host tool registry could not confirm bash (${bash.reason})`;
    log(`[tool-cli] Bridge not started: ${reason}`);
    return { kind: "no_bash", reason };
  }

  try {
    const endpoint = await server.start(log);
    const bridgeInfo = await (options.verify ?? verifyToolCliBridge)(endpoint);
    environment.setEnv(PORT_ENV_VAR, String(endpoint.port));
    environment.setEnv(TOKEN_ENV_VAR, endpoint.token);
    log(
      `[tool-cli] Verified ${bridgeInfo.bridgeProtocol.name} v${bridgeInfo.bridgeProtocol.version} ` +
        `from ${bridgeInfo.serverImplementation.name}@${bridgeInfo.serverImplementation.version}`,
    );
    return { kind: "verified", port: endpoint.port, bridgeInfo };
  } catch (error) {
    let cleanupError: unknown;
    try {
      await server.stop();
    } catch (caught) {
      cleanupError = caught;
    }
    withholdToolCliCredentials(environment);
    const reason =
      formatToolCliBridgeError(error) +
      (cleanupError !== undefined
        ? ` Bridge cleanup also failed: ${formatToolCliBridgeError(cleanupError)}`
        : "");
    log(`[tool-cli] Bridge unavailable: ${reason}`);
    return cleanupError === undefined && isToolCliCompatibilityError(error)
      ? { kind: "incompatible", reason }
      : { kind: "failed", reason };
  }
}
