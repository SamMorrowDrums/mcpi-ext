#!/usr/bin/env node
/**
 * Integration smoke test: connect to the test-echo-server via stdio,
 * discover tools, call the echo tool, disconnect, exit 0.
 */
import { McpClientManager } from "../dist/mcp/client-manager.js";

const manager = new McpClientManager();

try {
  await manager.connectAll(
    {
      mcpServers: {
        "test-echo": {
          type: "stdio",
          command: "node",
          args: ["scripts/test-echo-server.mjs"],
        },
      },
    },
    (msg) => console.log(msg),
  );

  const servers = manager.getConnectedServers();
  if (servers.length !== 1) {
    throw new Error(`Expected 1 server, got ${servers.length}`);
  }

  const tools = manager.getTools();
  console.log(`Discovered ${tools.length} tool(s): ${tools.map((t) => t.name).join(", ")}`);

  const echoTool = tools.find((t) => t.name === "echo");
  if (!echoTool) {
    throw new Error('Expected to find "echo" tool');
  }

  // Call the tool via the client
  const client = manager.getClient("test-echo");
  if (!client) throw new Error("No client for test-echo");

  const result = await client.callTool({
    name: "echo",
    arguments: { message: "hello from integration test" },
  });

  const text = result.content?.[0]?.text;
  if (text !== "hello from integration test") {
    throw new Error(`Unexpected echo result: ${JSON.stringify(result)}`);
  }
  console.log(`Echo tool returned: "${text}"`);

  await manager.disconnectAll();
  console.log("Integration test passed ✓");
  process.exit(0);
} catch (err) {
  console.error("Integration test failed:", err);
  await manager.disconnectAll().catch(() => {});
  process.exit(1);
}
