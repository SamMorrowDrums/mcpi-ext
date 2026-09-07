import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplateType,
} from "@modelcontextprotocol/client";
import {
  BRIDGE_RPC_OPERATIONS,
  PORT_ENV_VAR,
  SERVER_IMPLEMENTATION_NAME,
  SERVER_IMPLEMENTATION_VERSION,
  TOKEN_ENV_VAR,
  type BridgeInfo,
} from "@sammorrowdrums/tool-cli/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import { type McpClientDiagnostics, MCP_CLIENT_IDENTITY } from "../mcp/client-factory.js";
import type { McpTool } from "../mcp/client-manager.js";
import { noSkillsExtensionGateway } from "../mcp/gateway-defaults.js";
import { McpPolicy, type McpPolicyGateway } from "../mcp/policy.js";
import { ToolCliServer, verifyToolCliBridge } from "./index.js";
import { createPolicyToolProvider, type PolicyToolProviderOptions } from "./provider.js";

const CLI_PATH = fileURLToPath(
  new URL("../../node_modules/@sammorrowdrums/tool-cli/dist/cli.js", import.meta.url),
);

const EMPTY_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object" as const,
  properties: {},
  additionalProperties: false,
};

const visibleTool: McpTool = {
  name: "read_weather",
  title: "Weather",
  description: "Read current weather",
  serverName: "alpha",
  inputSchema: EMPTY_SCHEMA,
  outputSchema: {
    type: "object",
    properties: { temp: { type: "number" } },
  },
  annotations: { readOnlyHint: true, destructiveHint: false },
  icons: [{ src: "data:image/svg+xml;base64,PHN2Zy8+" }],
};

const gatedTool: McpTool = {
  name: "secret_probe",
  serverName: "alpha",
  inputSchema: EMPTY_SCHEMA,
  annotations: { readOnlyHint: true, destructiveHint: false },
};

const BINARY_BYTES = Buffer.from([0, 1, 2, 127, 255]);
const BINARY_BASE64 = BINARY_BYTES.toString("base64");

const resources: Resource[] = [
  {
    uri: "file:///notes.txt",
    name: "Notes",
    mimeType: "text/plain",
    annotations: { audience: ["assistant"], priority: 0 },
    _meta: { empty: "", falsey: false },
  },
  {
    uri: "file:///binary.bin",
    name: "Binary",
    mimeType: "application/octet-stream",
    size: BINARY_BYTES.length,
  },
  {
    uri: "skill://probe/SKILL.md",
    name: "Probe skill",
    mimeType: "text/markdown",
  },
];

const resourceTemplates: ResourceTemplateType[] = [
  {
    uriTemplate: "file:///logs/{date}.txt",
    name: "Daily log",
    _meta: { rank: 0 },
  },
  {
    uriTemplate: "skill://probe/{path}",
    name: "Probe skill file",
  },
];

const diagnostics: McpClientDiagnostics = {
  protocolVersion: "2025-06-18",
  protocolEra: "modern",
  discoverResult: {
    supportedVersions: ["2025-06-18"],
    capabilities: { tools: {}, resources: {} },
  },
  serverImplementation: { name: "fixture-mcp", version: "4.2.0" },
  serverCapabilities: {
    tools: { listChanged: true },
    resources: { listChanged: false, subscribe: false },
  },
  skillsExtension: {
    requested: false,
    revision: "2025-01-17",
    status: "draft",
    serverDeclared: false,
    serverCapability: undefined,
  },
};

const upstreamDiagnostics: NonNullable<PolicyToolProviderOptions["upstream"]> = {
  getConnectedServers: () => ["alpha"],
  getToolsForServer: () => [visibleTool, gatedTool],
  getDiagnostics: () => diagnostics,
};

const servers: ToolCliServer[] = [];

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
});

interface StartBridgeOptions {
  gate?: boolean;
  result?: CallToolResult;
  callTool?: McpPolicyGateway["callTool"];
}

async function startBridge(options: StartBridgeOptions = {}) {
  const defaultResult: CallToolResult = {
    content: [{ type: "text", text: "sunny" }],
    structuredContent: { temp: 21 },
  };
  const dispatch: McpPolicyGateway["callTool"] =
    options.callTool ??
    ((_serverName, _toolName, _args) =>
      Promise.resolve(adaptTerminalCallToolResult(options.result ?? defaultResult)));
  const upstream = vi.fn(dispatch);
  const listResources = vi.fn((_serverName: string, _signal?: AbortSignal) =>
    Promise.resolve(resources),
  );
  const listResourceTemplates = vi.fn((_serverName: string, _signal?: AbortSignal) =>
    Promise.resolve(resourceTemplates),
  );
  const readResource = vi.fn(
    (_serverName: string, uri: string, _signal?: AbortSignal): Promise<ReadResourceResult> => {
      if (uri === "file:///binary.bin") {
        return Promise.resolve({
          contents: [
            {
              uri,
              mimeType: "application/octet-stream",
              blob: BINARY_BASE64,
              _meta: { offset: 0 },
            },
          ],
          _meta: { complete: true },
        });
      }
      if (uri === "skill://probe/SKILL.md") {
        return Promise.resolve({
          contents: [{ uri, mimeType: "text/markdown", text: "SECRET SKILL BODY" }],
        });
      }
      return Promise.resolve({
        contents: [
          {
            uri,
            mimeType: "text/plain",
            text: "",
            _meta: { empty: "", falsey: false },
          },
        ],
        _meta: { cursor: null },
      });
    },
  );

  const gateway: McpPolicyGateway = {
    ...noSkillsExtensionGateway,
    getConnectedServers: () => ["alpha"],
    getToolsForServer: () => [visibleTool, gatedTool],
    callTool: upstream,
    listResources,
    listResourceTemplates,
    readResource,
  };

  const policy = new McpPolicy({ gateway });
  if (options.gate !== false) {
    policy.registerSkills([
      {
        name: "probe",
        uri: "skill://probe/SKILL.md",
        serverName: "alpha",
        allowedTools: ["secret_probe"],
      },
    ]);
  }

  const provider = createPolicyToolProvider(policy, { upstream: upstreamDiagnostics });
  const server = new ToolCliServer(provider);
  servers.push(server);
  const endpoint = await server.start(() => undefined);

  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> => {
    const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await response.json()) as Record<string, unknown>;
  };

  return {
    endpoint,
    listResources,
    listResourceTemplates,
    policy,
    readResource,
    rpc,
    upstream,
  };
}

function runCli(
  args: string[],
  endpoint: { port: number; token: string },
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI_PATH, ...args],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          [PORT_ENV_VAR]: String(endpoint.port),
          [TOKEN_ENV_VAR]: endpoint.token,
        },
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === "number" ? error.code : error === null ? 0 : 1;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

describe("tool-cli v1 authenticated bridge", () => {
  it("reports the exact operation/capability contract and live upstream diagnostics", async () => {
    const { endpoint, rpc } = await startBridge();

    const response = await rpc("getBridgeInfo");
    const info = response.result as BridgeInfo;

    expect(info.bridgeProtocol).toEqual({
      name: "tool-cli-bridge",
      major: 1,
      version: "1.0",
    });
    expect(info.serverImplementation).toEqual({
      name: SERVER_IMPLEMENTATION_NAME,
      version: SERVER_IMPLEMENTATION_VERSION,
    });
    expect(info.operations).toEqual(BRIDGE_RPC_OPERATIONS);
    expect(info.capabilities).toMatchObject({
      authentication: { required: true, scheme: "bearer" },
      tools: { discovery: true, calls: true, inputSchemaValidation: true },
      resources: { list: true, templates: true, read: true },
      cancellation: { providerAbortSignal: true },
    });
    expect(info.upstreamMcp).toEqual({
      protocolVersion: "2025-06-18",
      implementation: { ...MCP_CLIENT_IDENTITY },
      capabilities: {
        multiplexedServers: true,
        tools: { serverCount: 1 },
        resources: { serverCount: 1 },
      },
      serverCount: 1,
      servers: [
        {
          name: "alpha",
          toolCount: 2,
          protocolVersion: "2025-06-18",
          protocolEra: "modern",
          implementation: { name: "fixture-mcp", version: "4.2.0" },
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: false, subscribe: false },
          },
          discoverResult: {
            supportedVersions: ["2025-06-18"],
            capabilities: { tools: {}, resources: {} },
          },
          skillsExtension: {
            requested: false,
            revision: "2025-01-17",
            status: "draft",
            serverDeclared: false,
          },
        },
      ],
    });
    await expect(verifyToolCliBridge(endpoint)).resolves.toEqual(info);
  });

  it("protects getBridgeInfo with bearer authentication", async () => {
    const { endpoint, upstream } = await startBridge();

    const response = await fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBridgeInfo", params: {} }),
    });

    expect(response.status).toBe(401);
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("tool-cli v1 policy-backed tools", () => {
  it("advertises exactly policy-visible tools and preserves their complete schemas", async () => {
    const { rpc } = await startBridge();

    const listed = await rpc("listTools", { server: "alpha" });
    const listResult = listed.result as { tools: { name: string }[] };
    expect(listResult.tools.map((entry) => entry.name)).toEqual(["read_weather"]);

    const described = await rpc("describeTool", {
      server: "alpha",
      tool: "read_weather",
    });
    expect(described.result).toEqual({
      name: "read_weather",
      title: "Weather",
      description: "Read current weather",
      inputSchema: EMPTY_SCHEMA,
      outputSchema: visibleTool.outputSchema,
      annotations: visibleTool.annotations,
      icons: visibleTool.icons,
    });
    expect(described.result).not.toHaveProperty("serverName");
  });

  it("hides and refuses gated tools before upstream dispatch", async () => {
    const { rpc, upstream } = await startBridge();

    const described = await rpc("describeTool", {
      server: "alpha",
      tool: "secret_probe",
    });
    const called = await rpc("callTool", {
      server: "alpha",
      tool: "secret_probe",
      arguments: {},
    });

    expect(described.error).toBeDefined();
    expect(called.error).toBeDefined();
    expect(JSON.stringify(called.error)).toContain("secret_probe");
    expect(upstream).not.toHaveBeenCalled();
  });

  it.each([
    ["unknown tool", { server: "alpha", tool: "ghost", arguments: {} }],
    ["unknown server", { server: "beta", tool: "read_weather", arguments: {} }],
  ])("refuses an %s before upstream dispatch", async (_label, params) => {
    const { rpc, upstream } = await startBridge();

    const response = await rpc("callTool", params);

    expect(response.error).toBeDefined();
    expect(upstream).not.toHaveBeenCalled();
  });

  it("rejects invalid arguments before policy or upstream dispatch", async () => {
    const { policy, rpc, upstream } = await startBridge();

    const response = await rpc("callTool", {
      server: "alpha",
      tool: "read_weather",
      arguments: { unexpected: true },
    });

    expect(response.error).toBeDefined();
    expect(JSON.stringify(response.error)).toContain("validationErrors");
    expect(upstream).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toHaveLength(0);
  });

  it("crosses policy and upstream exactly once for an allowed call", async () => {
    const { policy, rpc, upstream } = await startBridge();

    const response = await rpc("callTool", {
      server: "alpha",
      tool: "read_weather",
      arguments: {},
    });

    expect(response.error).toBeUndefined();
    expect(upstream).toHaveBeenCalledOnce();
    expect(policy.getAuditLog()).toEqual([
      expect.objectContaining({
        source: "tool-cli",
        operation: "tool",
        toolName: "read_weather",
        decision: "allowed",
      }),
    ]);
  });

  it.each([false, 0, "", null, [], { nested: ["value"] }])(
    "preserves arbitrary structuredContent %j",
    async (structuredContent) => {
      const { rpc } = await startBridge({
        result: { content: [], structuredContent },
      });

      const response = await rpc("callTool", {
        server: "alpha",
        tool: "read_weather",
        arguments: {},
      });
      const result = response.result as CallToolResult;

      expect(Object.hasOwn(result, "structuredContent")).toBe(true);
      expect(result.structuredContent).toEqual(structuredContent);
    },
  );

  it("preserves modern content blocks and falsey metadata end-to-end", async () => {
    const modernResult: CallToolResult = {
      content: [
        {
          type: "text",
          text: "",
          annotations: { audience: ["assistant"], priority: 0 },
          _meta: { falsey: false },
        },
        {
          type: "resource_link",
          uri: "file:///result.json",
          name: "Result",
          title: "",
          mimeType: "application/json",
          description: "",
          size: 0,
          _meta: { offset: 0 },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///inline.json",
            mimeType: "application/json",
            text: "",
            _meta: { nullable: null },
          },
          annotations: { audience: ["assistant"], priority: 0 },
        },
      ],
      structuredContent: null,
      isError: false,
      _meta: { count: 0 },
    };
    const { rpc } = await startBridge({ result: modernResult });

    const response = await rpc("callTool", {
      server: "alpha",
      tool: "read_weather",
      arguments: {},
    });

    expect(response.result).toEqual(modernResult);
  });

  it("propagates HTTP client cancellation through policy to the MCP gateway signal", async () => {
    let resolveEntered: ((signal: AbortSignal | undefined) => void) | undefined;
    const entered = new Promise<AbortSignal | undefined>((resolve) => {
      resolveEntered = resolve;
    });
    const callTool: McpPolicyGateway["callTool"] = (_serverName, _toolName, _args, signal) =>
      new Promise((resolve, reject) => {
        resolveEntered?.(signal);
        if (signal === undefined) {
          reject(new Error("missing cancellation signal"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("cancelled upstream")), {
          once: true,
        });
        void resolve;
      });
    const { endpoint, upstream } = await startBridge({ callTool });
    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${endpoint.port}/rpc`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${endpoint.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "callTool",
        params: { server: "alpha", tool: "read_weather", arguments: {} },
      }),
      signal: controller.signal,
    });

    const upstreamSignal = await entered;
    controller.abort("test cancellation");
    await request.catch(() => undefined);

    expect(upstream).toHaveBeenCalledOnce();
    expect(upstreamSignal).toBeDefined();
    await vi.waitFor(() => {
      expect(upstreamSignal?.aborted).toBe(true);
    });
  });
});

describe("tool-cli v1 policy-backed resources", () => {
  it("lists ordinary resources/templates losslessly while isolating skill://", async () => {
    const { listResources, listResourceTemplates, policy, rpc } = await startBridge();

    const listed = await rpc("listResources", { server: "alpha" });
    const templates = await rpc("listResourceTemplates", { server: "alpha" });

    expect(listed.result).toEqual({
      server: "alpha",
      resources: resources
        .filter((resource) => !resource.uri.startsWith("skill://"))
        .sort((left, right) => left.uri.localeCompare(right.uri)),
    });
    expect(templates.result).toEqual({
      server: "alpha",
      templates: resourceTemplates.filter(
        (template) => !template.uriTemplate.startsWith("skill://"),
      ),
    });
    expect(JSON.stringify([listed.result, templates.result])).not.toContain("skill://");
    expect(listResources).toHaveBeenCalledOnce();
    expect(listResourceTemplates).toHaveBeenCalledOnce();
    expect(policy.getAuditLog().map((record) => record.operation)).toEqual([
      "resource-list",
      "resource-templates",
    ]);
  });

  it("refuses skill:// reads before dispatch and directs callers to load_skill", async () => {
    const { readResource, rpc } = await startBridge();

    const response = await rpc("readResource", {
      server: "alpha",
      uri: "skill://probe/SKILL.md",
    });

    expect(response.error).toBeDefined();
    expect(JSON.stringify(response.error)).toContain("load_skill");
    expect(JSON.stringify(response)).not.toContain("SECRET SKILL BODY");
    expect(readResource).not.toHaveBeenCalled();
  });

  it("preserves text, binary, metadata, and falsey resource fields through one policy pass", async () => {
    const { policy, readResource, rpc } = await startBridge();

    const text = await rpc("readResource", {
      server: "alpha",
      uri: "file:///notes.txt",
    });
    const binary = await rpc("readResource", {
      server: "alpha",
      uri: "file:///binary.bin",
    });

    expect(text.result).toEqual({
      contents: [
        {
          uri: "file:///notes.txt",
          mimeType: "text/plain",
          text: "",
          _meta: { empty: "", falsey: false },
        },
      ],
      _meta: { cursor: null },
    });
    expect(binary.result).toEqual({
      contents: [
        {
          uri: "file:///binary.bin",
          mimeType: "application/octet-stream",
          blob: BINARY_BASE64,
          _meta: { offset: 0 },
        },
      ],
      _meta: { complete: true },
    });
    expect(readResource).toHaveBeenCalledTimes(2);
    expect(policy.getAuditLog().map((record) => record.operation)).toEqual([
      "resource",
      "resource",
    ]);
  });

  it("writes base64-decoded binary resources with the packed v1 CLI --out path", async () => {
    const { endpoint } = await startBridge();
    const scratch = mkdtempSync(join(tmpdir(), "mcpi-ext-tool-cli-v1-"));
    const outputPath = join(scratch, "binary.bin");

    try {
      const result = await runCli(
        ["resource", "read", "--server", "alpha", "file:///binary.bin", "--out", outputPath],
        endpoint,
      );

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Written to:");
      expect(readFileSync(outputPath)).toEqual(BINARY_BYTES);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
