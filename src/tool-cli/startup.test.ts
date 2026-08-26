import {
  BRIDGE_RPC_OPERATIONS,
  BridgeCompatibilityError,
  RpcTimeoutError,
  type BridgeInfo,
} from "@sammorrowdrums/tool-cli/client";
import { describe, expect, it, vi } from "vitest";
import {
  startToolCliBridge,
  type ToolCliBridgeServer,
  type ToolCliEnvironment,
} from "./startup.js";

const BRIDGE_INFO: BridgeInfo = {
  bridgeProtocol: { name: "tool-cli-bridge", major: 1, version: "1.0" },
  serverImplementation: { name: "@sammorrowdrums/tool-cli", version: "1.0.0" },
  operations: [...BRIDGE_RPC_OPERATIONS],
  capabilities: {
    authentication: { required: true, scheme: "bearer" },
    tools: {
      discovery: true,
      calls: true,
      inputSchemaValidation: true,
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
      supportedJsonSchemaDialects: [
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2019-09/schema",
        "http://json-schema.org/draft-07/schema#",
      ],
    },
    resources: { list: true, templates: true, read: true },
    cancellation: { providerAbortSignal: true },
  },
  upstreamMcp: { serverCount: 1 },
};

function harness() {
  const events: string[] = [];
  const server: ToolCliBridgeServer = {
    start: vi.fn(async () => {
      events.push("start");
      return { port: 7179, token: "session-token" };
    }),
    stop: vi.fn(async () => {
      events.push("stop");
    }),
  };
  const environment: ToolCliEnvironment = {
    setEnv: vi.fn((name, value) => {
      events.push(`set:${name}=${value}`);
    }),
    unsetEnv: vi.fn((name) => {
      events.push(`unset:${name}`);
    }),
  };
  const log = vi.fn<(message: string) => void>();
  return { environment, events, log, server };
}

describe("tool-cli bridge startup gating", () => {
  it("exposes credentials only after a successful authenticated compatible handshake", async () => {
    const h = harness();
    const verify = vi.fn(async () => {
      h.events.push("verify");
      expect(h.environment.setEnv).toHaveBeenNthCalledWith(1, "TOOL_CLI_HOST", "127.0.0.1");
      expect(h.environment.setEnv).toHaveBeenNthCalledWith(2, "TOOL_CLI_PORT", "");
      expect(h.environment.setEnv).toHaveBeenNthCalledWith(3, "TOOL_CLI_TOKEN", "");
      return BRIDGE_INFO;
    });

    const state = await startToolCliBridge({
      bash: { kind: "registered", toolName: "bash" },
      server: h.server,
      environment: h.environment,
      log: h.log,
      verify,
    });

    expect(state).toEqual({ kind: "verified", port: 7179, bridgeInfo: BRIDGE_INFO });
    expect(h.events).toEqual([
      "set:TOOL_CLI_HOST=127.0.0.1",
      "set:TOOL_CLI_PORT=",
      "set:TOOL_CLI_TOKEN=",
      "start",
      "verify",
      "set:TOOL_CLI_PORT=7179",
      "set:TOOL_CLI_TOKEN=session-token",
    ]);
    expect(h.environment.setEnv).toHaveBeenNthCalledWith(4, "TOOL_CLI_PORT", "7179");
    expect(h.environment.setEnv).toHaveBeenNthCalledWith(5, "TOOL_CLI_TOKEN", "session-token");
  });

  it("stops and withholds credentials after a handshake failure", async () => {
    const h = harness();

    const state = await startToolCliBridge({
      bash: { kind: "registered", toolName: "bash" },
      server: h.server,
      environment: h.environment,
      log: h.log,
      verify: () => Promise.reject(new RpcTimeoutError(250)),
    });

    expect(state.kind).toBe("failed");
    expect(state).toHaveProperty("reason", expect.stringContaining("timed out after 250ms"));
    expect(h.server.stop).toHaveBeenCalledOnce();
    expect(h.environment.setEnv).toHaveBeenCalledTimes(6);
    expect(h.environment.setEnv).not.toHaveBeenCalledWith("TOOL_CLI_PORT", "7179");
    expect(h.environment.setEnv).not.toHaveBeenCalledWith("TOOL_CLI_TOKEN", "session-token");
    expect(h.environment.unsetEnv).not.toHaveBeenCalled();
  });

  it("distinguishes an incompatible major and withholds credentials", async () => {
    const h = harness();

    const state = await startToolCliBridge({
      bash: { kind: "registered", toolName: "bash" },
      server: h.server,
      environment: h.environment,
      log: h.log,
      verify: () =>
        Promise.reject(
          new BridgeCompatibilityError(
            "expected tool-cli-bridge major 1, received tool-cli-bridge major 2",
          ),
        ),
    });

    expect(state.kind).toBe("incompatible");
    expect(state).toHaveProperty(
      "reason",
      expect.stringContaining("received tool-cli-bridge major 2"),
    );
    expect(h.server.stop).toHaveBeenCalledOnce();
    expect(h.environment.setEnv).not.toHaveBeenCalledWith("TOOL_CLI_PORT", "7179");
    expect(h.environment.setEnv).not.toHaveBeenCalledWith("TOOL_CLI_TOKEN", "session-token");
  });

  it.each([
    { kind: "absent" as const },
    { kind: "undiscoverable" as const, reason: "getAllTools unavailable" },
  ])("does not start or expose the bridge when bash is unavailable", async (bash) => {
    const h = harness();
    const verify = vi.fn(async () => BRIDGE_INFO);

    const state = await startToolCliBridge({
      bash,
      server: h.server,
      environment: h.environment,
      log: h.log,
      verify,
    });

    expect(state.kind).toBe("no_bash");
    expect(h.server.start).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(h.environment.setEnv).toHaveBeenNthCalledWith(1, "TOOL_CLI_HOST", "127.0.0.1");
    expect(h.environment.setEnv).toHaveBeenNthCalledWith(2, "TOOL_CLI_PORT", "");
    expect(h.environment.setEnv).toHaveBeenNthCalledWith(3, "TOOL_CLI_TOKEN", "");
    expect(h.environment.unsetEnv).not.toHaveBeenCalled();
  });
});
