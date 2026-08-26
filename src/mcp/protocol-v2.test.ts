import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
  type ListResourcesResult,
  type ListToolsResult,
} from "@modelcontextprotocol/client";
import {
  createMcpHandler,
  McpServer,
  Server,
  inputRequired,
  inputResponse,
} from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { discoverSkillsFromServer } from "../skills/discover.js";
import { SKILLS_EXTENSION_REVISION } from "../skills/sep2640/spec.js";
import { noSkillsExtensionGateway } from "./gateway-defaults.js";
import { McpPolicy } from "./policy.js";
import {
  createMcpClient,
  getMcpClientDiagnostics,
  MCP_CLIENT_IDENTITY,
  type McpElicitationHandler,
} from "./client-factory.js";

const clients: Client[] = [];
const servers: (McpServer | Server)[] = [];
const handlers: ReturnType<typeof createMcpHandler>[] = [];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.allSettled(handlers.splice(0).map((handler) => handler.close()));
  await Promise.allSettled(servers.splice(0).map((server) => server.close()));
});

describe("MCP v2 client seam", () => {
  it("negotiates the pinned 2026-07-28 era and advertises only supported capabilities", async () => {
    const client = createMcpClient({ elicitation: declineElicitation });

    const server = await connectModern(client, () => {
      const instance = new McpServer(
        { name: "modern-fixture", version: "1.0.0" },
        { supportedProtocolVersions: ["2026-07-28"] },
      );
      instance.registerTool("ping", {}, async () => ({
        content: [{ type: "text", text: "pong" }],
      }));
      return instance;
    });

    expect(getMcpClientDiagnostics(client)).toMatchObject({
      protocolEra: "modern",
      discoverResult: { supportedVersions: ["2026-07-28"] },
    });
    expect(server.server.getClientVersion()).toEqual(MCP_CLIENT_IDENTITY);
    expect(server.server.getClientCapabilities()).toEqual({
      elicitation: { form: {} },
      extensions: {},
    });
  });

  it("falls back automatically to a legacy server without a discover result", async () => {
    const server = new McpServer(
      { name: "legacy-fixture", version: "1.0.0" },
      { supportedProtocolVersions: ["2025-11-25"] },
    );
    server.registerTool("ping", {}, async () => ({
      content: [{ type: "text", text: "pong" }],
    }));
    const client = createMcpClient({ elicitation: declineElicitation });

    await connectLegacy(client, server);

    expect(getMcpClientDiagnostics(client)).toEqual({
      protocolVersion: "2025-11-25",
      protocolEra: "legacy",
      discoverResult: undefined,
      serverImplementation: { name: "legacy-fixture", version: "1.0.0" },
      serverCapabilities: { tools: { listChanged: true } },
      // A legacy server declares no extensions, and this client did not
      // request the draft skills extension, so the diagnostic reports it
      // as neither requested nor available rather than omitting it.
      skillsExtension: {
        requested: false,
        revision: SKILLS_EXTENSION_REVISION,
        status: "draft",
        serverDeclared: false,
        serverCapability: undefined,
      },
    });
    await expect(client.callTool({ name: "ping", arguments: {} })).resolves.toMatchObject({
      content: [{ type: "text", text: "pong" }],
    });
  });

  it("lets the SDK complete MRTR, echo opaque requestState, and expose only the terminal result", async () => {
    const requestState = "opaque-state:do-not-inspect";
    let observedRequestState: unknown;
    const elicit = vi.fn(async () => ({ action: "decline" as const }));
    const client = createMcpClient({ elicitation: { elicit } });

    await connectModern(client, () => {
      const server = new McpServer(
        { name: "mrtr-fixture", version: "1.0.0" },
        { supportedProtocolVersions: ["2026-07-28"] },
      );
      server.registerTool("read-only-lookup", {}, async (context) => {
        const response = inputResponse(context.mcpReq.inputResponses, "approval");
        if (response.kind === "missing") {
          return inputRequired({
            inputRequests: {
              approval: inputRequired.elicit({
                message: "Approve this read-only lookup?",
                requestedSchema: z.object({ approved: z.boolean() }),
              }),
            },
            requestState,
          });
        }

        observedRequestState = context.mcpReq.requestState();
        const action = response.kind === "elicit" ? response.action : response.kind;
        return {
          content: [{ type: "text" as const, text: `lookup ${action}` }],
          structuredContent: { action },
        };
      });
      return server;
    });
    const result = await client.callTool({ name: "read-only-lookup", arguments: {} });

    expect(elicit).toHaveBeenCalledOnce();
    expect(observedRequestState).toBe(requestState);
    expect(result).toMatchObject({
      content: [{ type: "text", text: "lookup decline" }],
      structuredContent: { action: "decline" },
    });
    expect(Object.hasOwn(result, "resultType")).toBe(false);
  });

  it("aggregates cursor pages for tools and skill resources", async () => {
    const listTools = vi.fn((request: { params?: { cursor?: string } }): ListToolsResult => {
      if (request.params?.cursor === "tools-page-2") {
        return { tools: [listedTool("alpha")] };
      }
      return { tools: [listedTool("zulu")], nextCursor: "tools-page-2" };
    });
    const listResources = vi.fn(
      (request: { params?: { cursor?: string } }): ListResourcesResult => {
        if (request.params?.cursor === "resources-page-2") {
          return {
            resources: [{ name: "alpha", uri: "skill://alpha/SKILL.md" }],
          };
        }
        return {
          resources: [{ name: "zulu", uri: "skill://zulu/SKILL.md" }],
          nextCursor: "resources-page-2",
        };
      },
    );
    const client = createMcpClient({ elicitation: declineElicitation });

    await connectModern(client, () => {
      const server = new Server(
        { name: "pagination-fixture", version: "1.0.0" },
        {
          capabilities: { tools: {}, resources: {} },
          supportedProtocolVersions: ["2026-07-28"],
        },
      );
      server.setRequestHandler("tools/list", listTools);
      server.setRequestHandler("resources/list", listResources);
      server.setRequestHandler("resources/read", (request) => {
        const name = request.params.uri.includes("alpha") ? "alpha" : "zulu";
        return {
          contents: [
            {
              uri: request.params.uri,
              text: `---\nname: ${name}\ndescription: ${name} skill\nallowed-tools: []\n---\n# ${name}`,
            },
          ],
        };
      });
      return server;
    });
    const tools = await client.listTools();
    const skills = await discoverSkillsFromServer(
      policyForClient(client, "pagination-fixture"),
      "pagination-fixture",
    );

    expect(tools.tools.map((tool) => tool.name)).toEqual(["zulu", "alpha"]);
    expect(skills.map((skill) => skill.name)).toEqual(["alpha", "zulu"]);
    expect(listTools).toHaveBeenCalledTimes(2);
    expect(listResources).toHaveBeenCalledTimes(2);
  });
});

async function connectLegacy(client: Client, server: McpServer | Server): Promise<void> {
  clients.push(client);
  servers.push(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
}

async function connectModern<T extends McpServer | Server>(
  client: Client,
  createServer: () => T,
): Promise<T> {
  let firstServer: T | undefined;
  const handler = createMcpHandler(
    () => {
      const server = createServer();
      firstServer ??= server;
      return server;
    },
    { legacy: "reject" },
  );
  const transport = new StreamableHTTPClientTransport(new URL("http://modern-fixture.test/mcp"), {
    fetch: (input, init) => handler.fetch(new Request(input, init)),
  });
  clients.push(client);
  handlers.push(handler);
  await client.connect(transport);

  if (firstServer === undefined) {
    throw new Error("Modern fixture did not construct a server");
  }
  return firstServer;
}

/** Adapt a bare v2 client into the policy gateway shape for discovery tests. */
function policyForClient(client: Client, serverName: string): McpPolicy {
  return new McpPolicy({
    gateway: {
      ...noSkillsExtensionGateway,
      getConnectedServers: () => [serverName],
      getToolsForServer: () => [],
      callTool: () => Promise.reject(new Error("tool calls are out of scope for this fixture")),
      listResources: async (name, signal) => {
        if (name !== serverName) throw new Error(`MCP server "${name}" is not connected`);
        const result = await client.listResources(undefined, {
          ...(signal ? { signal } : {}),
        });
        return [...result.resources].sort((left, right) => (left.uri < right.uri ? -1 : 1));
      },
      listResourceTemplates: async (name, signal) => {
        if (name !== serverName) throw new Error(`MCP server "${name}" is not connected`);
        const result = await client.listResourceTemplates(undefined, {
          ...(signal ? { signal } : {}),
        });
        return result.resourceTemplates;
      },
      readResource: (name, uri, signal) => {
        if (name !== serverName) throw new Error(`MCP server "${name}" is not connected`);
        return client.readResource({ uri }, { ...(signal ? { signal } : {}) });
      },
    },
  });
}

function listedTool(name: string) {
  return {
    name,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object" as const,
      properties: {},
    },
  };
}

const declineElicitation: McpElicitationHandler = {
  elicit: async () => ({ action: "decline" }),
};
