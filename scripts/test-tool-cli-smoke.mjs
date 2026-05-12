#!/usr/bin/env node
/**
 * Smoke test: start RPC server with the weather test server,
 * exercise every tool-cli command via the CLI binary, then shut down.
 *
 * Tests the full wiring: ToolProvider → ToolCliServer → tool-cli CLI.
 */
import { McpClientManager } from "../dist/mcp/client-manager.js";
import { ToolCliServer } from "@sammorrowdrums/tool-cli/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

// Resolve the tool-cli binary from node_modules/.bin
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "..", "node_modules", ".bin", "tool-cli");

const manager = new McpClientManager();
let server;

async function run(...args) {
  const { stdout } = await execFileAsync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: {
      ...process.env,
      TOOL_CLI_PORT: String(server.getPort()),
      TOOL_CLI_TOKEN: token,
    },
  });
  console.log(`$ tool-cli ${args.join(" ")}`);
  console.log(stdout);
  return stdout;
}

let token;

try {
  await manager.connectOne("weather", {
    type: "stdio",
    command: "node",
    args: ["dist/test-servers/weather-stdio.js"],
  });

  // Bridge McpClientManager to ToolProvider
  const provider = {
    getServerNames: () => manager.getConnectedServers(),
    getTools: (s) => manager.getToolsForServer(s),
    async callTool(s, tool, args) {
      const client = manager.getClient(s);
      if (!client) throw new Error(`No client for "${s}"`);
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        content: result.content,
        isError: result.isError === true ? true : undefined,
        structuredContent: result.structuredContent,
      };
    },
  };

  server = new ToolCliServer(provider);
  const startResult = await server.start(console.log);
  token = startResult.token;

  // --help: list servers
  const help = await run("--help");
  if (!help.includes("weather")) throw new Error("--help missing weather server");

  // <server>: list tools
  const tools = await run("weather");
  if (!tools.includes("check_weather_for_city"))
    throw new Error("tool list missing check_weather_for_city");

  // <server> <tool>: describe
  const desc = await run("weather", "check_weather_for_city");
  if (!desc.includes("city")) throw new Error("describe missing city param");

  // <server> <tool> <args>: call
  const result = await run("weather", "check_weather_for_city", '{"city":"London"}');
  if (!result.includes("London")) throw new Error("call result missing London");

  await server.stop();
  await manager.disconnectAll();
  console.log("Smoke test passed ✓");
  process.exit(0);
} catch (err) {
  console.error("Smoke test failed:", err);
  await server?.stop().catch(() => {});
  await manager.disconnectAll().catch(() => {});
  process.exit(1);
}
