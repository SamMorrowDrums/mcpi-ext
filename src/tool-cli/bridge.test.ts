import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  BRIDGE_RPC_OPERATIONS,
  BridgeCompatibilityError,
  RpcHttpError,
  RpcProtocolError,
  RpcTimeoutError,
  type BridgeInfo,
} from "@sammorrowdrums/tool-cli/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatToolCliBridgeError,
  isToolCliCompatibilityError,
  verifyToolCliBridge,
} from "./bridge.js";

const TOKEN = "fixture-token";

const compatibleInfo: BridgeInfo = {
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
  upstreamMcp: { serverCount: 0, servers: [] },
};

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

async function startHandshakeFixture(options: {
  result?: unknown;
  rpcError?: { code: number; message: string; data?: unknown };
  delayMs?: number;
  token?: string;
}) {
  const token = options.token ?? TOKEN;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const parsed = JSON.parse(body) as { id: number | string | null };
      const send = () => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            options.rpcError
              ? { jsonrpc: "2.0", id: parsed.id, error: options.rpcError }
              : { jsonrpc: "2.0", id: parsed.id, result: options.result },
          ),
        );
      };
      if (options.delayMs !== undefined) {
        setTimeout(send, options.delayMs);
      } else {
        send();
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, token };
}

describe("tool-cli bridge compatibility", () => {
  it("fails loudly when the bridge major is incompatible", async () => {
    const endpoint = await startHandshakeFixture({
      result: {
        ...compatibleInfo,
        bridgeProtocol: { ...compatibleInfo.bridgeProtocol, major: 2, version: "2.0" },
      },
    });

    const error = await verifyToolCliBridge(endpoint).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeCompatibilityError);
    expect(isToolCliCompatibilityError(error)).toBe(true);
    expect(formatToolCliBridgeError(error)).toContain(
      "expected tool-cli-bridge major 1, received tool-cli-bridge major 2",
    );
  });

  it("rejects a nominal v1 bridge missing a required deterministic operation", async () => {
    const endpoint = await startHandshakeFixture({
      result: {
        ...compatibleInfo,
        operations: compatibleInfo.operations.filter((operation) => operation !== "readResource"),
      },
    });

    const error = await verifyToolCliBridge(endpoint).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeCompatibilityError);
    expect(formatToolCliBridgeError(error)).toContain(
      "missing required operation(s): readResource",
    );
  });

  it("restores pre-existing client environment after a successful handshake", async () => {
    const endpoint = await startHandshakeFixture({ result: compatibleInfo });
    const previousPort = process.env.TOOL_CLI_PORT;
    const previousToken = process.env.TOOL_CLI_TOKEN;
    const previousHost = process.env.TOOL_CLI_HOST;
    process.env.TOOL_CLI_PORT = "4567";
    process.env.TOOL_CLI_TOKEN = "prior-session-token";
    process.env.TOOL_CLI_HOST = "192.0.2.1";

    try {
      await expect(verifyToolCliBridge(endpoint)).resolves.toEqual(compatibleInfo);
      expect(process.env.TOOL_CLI_PORT).toBe("4567");
      expect(process.env.TOOL_CLI_TOKEN).toBe("prior-session-token");
      expect(process.env.TOOL_CLI_HOST).toBe("192.0.2.1");
    } finally {
      restoreEnvironment("TOOL_CLI_PORT", previousPort);
      restoreEnvironment("TOOL_CLI_TOKEN", previousToken);
      restoreEnvironment("TOOL_CLI_HOST", previousHost);
    }
  });

  it("serializes concurrent handshakes so global client credentials restore safely", async () => {
    const first = await startHandshakeFixture({
      result: compatibleInfo,
      delayMs: 10,
      token: "first-token",
    });
    const second = await startHandshakeFixture({
      result: compatibleInfo,
      delayMs: 50,
      token: "second-token",
    });
    const previousPort = process.env.TOOL_CLI_PORT;
    const previousToken = process.env.TOOL_CLI_TOKEN;
    const previousHost = process.env.TOOL_CLI_HOST;
    process.env.TOOL_CLI_PORT = "4567";
    process.env.TOOL_CLI_TOKEN = "original-token";
    process.env.TOOL_CLI_HOST = "192.0.2.1";

    try {
      await expect(
        Promise.all([verifyToolCliBridge(first), verifyToolCliBridge(second)]),
      ).resolves.toEqual([compatibleInfo, compatibleInfo]);
      expect(process.env.TOOL_CLI_PORT).toBe("4567");
      expect(process.env.TOOL_CLI_TOKEN).toBe("original-token");
      expect(process.env.TOOL_CLI_HOST).toBe("192.0.2.1");
    } finally {
      restoreEnvironment("TOOL_CLI_PORT", previousPort);
      restoreEnvironment("TOOL_CLI_TOKEN", previousToken);
      restoreEnvironment("TOOL_CLI_HOST", previousHost);
    }
  });

  it.each([
    {
      label: "null upstream summary",
      result: { ...compatibleInfo, upstreamMcp: null },
    },
    {
      label: "contradictory protocol version",
      result: {
        ...compatibleInfo,
        bridgeProtocol: { ...compatibleInfo.bridgeProtocol, version: "2.0" },
      },
    },
    {
      label: "missing nested capabilities",
      result: {
        ...compatibleInfo,
        capabilities: { ...compatibleInfo.capabilities, tools: undefined },
      },
    },
    {
      label: "unsupported schema dialect",
      result: {
        ...compatibleInfo,
        capabilities: {
          ...compatibleInfo.capabilities,
          tools: {
            ...compatibleInfo.capabilities.tools,
            jsonSchemaDialect: "http://json-schema.org/draft-04/schema#",
          },
        },
      },
    },
  ])("classifies malformed v1 metadata as incompatible: $label", async ({ result }) => {
    const endpoint = await startHandshakeFixture({ result });

    const error = await verifyToolCliBridge(endpoint).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BridgeCompatibilityError);
    expect(isToolCliCompatibilityError(error)).toBe(true);
  });
});

describe("actionable typed bridge errors", () => {
  it("surfaces authenticated HTTP failures without exposing the token", async () => {
    const endpoint = await startHandshakeFixture({ result: compatibleInfo });

    const error = await verifyToolCliBridge({ ...endpoint, token: "wrong-token" }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(RpcHttpError);
    expect(formatToolCliBridgeError(error)).toContain(
      "Tool-cli bridge HTTP 401 Unauthorized: Unauthorized",
    );
    expect(formatToolCliBridgeError(error)).not.toContain("wrong-token");
  });

  it("surfaces JSON-RPC codes and data actionably", async () => {
    const endpoint = await startHandshakeFixture({
      rpcError: {
        code: -32601,
        message: "Method not found: getBridgeInfo",
        data: { supported: ["listServers"] },
      },
    });

    const error = await verifyToolCliBridge(endpoint).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcProtocolError);
    expect(formatToolCliBridgeError(error)).toContain(
      "Tool-cli bridge RPC -32601: Method not found: getBridgeInfo",
    );
    expect(formatToolCliBridgeError(error)).toContain('"supported":["listServers"]');
  });

  it("surfaces finite handshake timeouts with a compatibility next step", async () => {
    const endpoint = await startHandshakeFixture({
      result: compatibleInfo,
      delayMs: 100,
    });

    const error = await verifyToolCliBridge(endpoint, 10).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(RpcTimeoutError);
    expect(formatToolCliBridgeError(error)).toContain("timed out after 10ms");
    expect(formatToolCliBridgeError(error)).toContain("Check bridge responsiveness");
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, name);
  } else {
    process.env[name] = value;
  }
}
