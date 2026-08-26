/**
 * Wire truthfulness for the skills extension capability.
 *
 * These tests read the bytes that actually cross the transport rather than the
 * object we intended to send. A capability is a promise about behaviour, so the
 * only useful assertion is on what the peer can observe.
 *
 * SEP-2640 puts `directoryRead` on the *server* side: the server declares it in
 * the initialize result, and clients "MUST NOT call `resources/directory/read`
 * against a server that has not declared `directoryRead: true`". There is no
 * client-side `directoryRead` capability, so a client that sent one would be
 * advertising a method it does not implement. The first group pins that down;
 * the second proves the fixture server keeps the same bargain, which is what
 * lets every other suite trust it.
 */
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it } from "vitest";
import { McpClientManager } from "./client-manager.js";
import { SKILLS_EXTENSION_NAME } from "../skills/sep2640/spec.js";
import { createSkillsExtensionServer } from "../test-servers/skills-extension-server.js";

interface JsonRpcMessage {
  method?: string;
  params?: Record<string, unknown>;
}

interface WireHarness {
  initialize: JsonRpcMessage;
  manager: McpClientManager;
  fixture: ReturnType<typeof createSkillsExtensionServer>;
  dispose: () => Promise<void>;
}

const live: WireHarness[] = [];

/**
 * Connect a real manager to a real fixture server and capture the raw
 * `initialize` request the client put on the wire.
 */
async function captureInitialize(options: {
  skillsExtension: boolean;
  directoryRead?: boolean;
}): Promise<WireHarness> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const sent: JsonRpcMessage[] = [];
  const realSend = clientTransport.send.bind(clientTransport);
  // Record rather than intercept: the message still reaches the server, so the
  // handshake we are inspecting is the one that actually established the session.
  clientTransport.send = async (message: unknown, ...rest: unknown[]) => {
    sent.push(message as JsonRpcMessage);
    return (realSend as (...args: unknown[]) => Promise<void>)(message, ...rest);
  };

  const fixture = createSkillsExtensionServer({
    skills: [
      {
        base: "skill://weather",
        document: "---\nname: weather\ndescription: Weather lookups\n---\n\nBody.\n",
        frontmatter: { name: "weather", description: "Weather lookups" },
      },
    ],
    directoryRead: options.directoryRead ?? false,
  });
  const manager = new McpClientManager({
    transportFactory: () => clientTransport,
    skillsExtension: options.skillsExtension,
  });

  await fixture.server.connect(serverTransport);
  await manager.connectAll({
    mcpServers: { fixture: { type: "stdio", command: "node", args: ["unused-in-memory"] } },
  });

  const initialize = sent.find((message) => message.method === "initialize");
  if (!initialize) throw new Error("client never sent initialize");

  const harness: WireHarness = {
    initialize,
    manager,
    fixture,
    dispose: async () => {
      await Promise.all([manager.disconnectAll(), fixture.server.close()]);
    },
  };
  live.push(harness);
  return harness;
}

afterEach(async () => {
  while (live.length > 0) {
    await live.pop()?.dispose();
  }
});

function extensionsOf(initialize: JsonRpcMessage): Record<string, unknown> {
  const capabilities = initialize.params?.["capabilities"] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return capabilities?.extensions ?? {};
}

describe("client initialize capabilities", () => {
  it("omits the skills extension entirely when it is disabled", async () => {
    const h = await captureInitialize({ skillsExtension: false });
    expect(extensionsOf(h.initialize)).toEqual({});
  });

  it("offers the skills extension as an empty object when enabled", async () => {
    const h = await captureInitialize({ skillsExtension: true });
    // Exactly `{}` — offering participation, claiming no server-side sub-features.
    expect(extensionsOf(h.initialize)).toEqual({ [SKILLS_EXTENSION_NAME]: {} });
  });

  it("never advertises directoryRead from the client side", async () => {
    for (const skillsExtension of [true, false]) {
      const h = await captureInitialize({ skillsExtension });
      // A substring check over the serialised request, so a `directoryRead`
      // smuggled in under any nesting still fails this test.
      expect(JSON.stringify(h.initialize)).not.toContain("directoryRead");
    }
  });

  it("does not let a server declaration leak back into the client offer", async () => {
    const h = await captureInitialize({ skillsExtension: true, directoryRead: true });
    expect(extensionsOf(h.initialize)).toEqual({ [SKILLS_EXTENSION_NAME]: {} });
  });
});

describe("fixture server declaration", () => {
  it("does not implement resources/directory/read unless it declared it", async () => {
    const h = await captureInitialize({ skillsExtension: true, directoryRead: false });

    // Not "returns an empty list" — the method must be genuinely absent, so a
    // client that ignores the declaration gets an error instead of a plausible
    // answer it was never entitled to. Routed through the production request
    // path so this is the same call a real caller would make.
    await expect(h.manager.requestDirectoryRead("fixture", "skill://weather")).rejects.toThrow(
      /method|not found|-32601/i,
    );
  });

  it("implements resources/directory/read when it declared it", async () => {
    const h = await captureInitialize({ skillsExtension: true, directoryRead: true });
    expect(h.manager.getDiagnostics("fixture")?.skillsExtension?.serverCapability).toEqual({
      directoryRead: true,
    });

    // Declaring it means answering it: the handler is registered, so an unknown
    // URI fails as "not a directory" rather than as an unimplemented method.
    await expect(h.manager.requestDirectoryRead("fixture", "skill://weather")).rejects.toThrow(
      /not a directory/i,
    );
  });
});
