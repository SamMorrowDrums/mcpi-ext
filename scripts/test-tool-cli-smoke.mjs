#!/usr/bin/env node
/**
 * Smoke test: start RPC server with the weather test server,
 * exercise every tool-cli command, then shut down.
 */
import { McpClientManager } from "../dist/mcp/client-manager.js";
import { ToolCliRpcServer } from "../dist/tool-cli/rpc-server.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CLI = "dist/tool-cli/cli.js";
const manager = new McpClientManager();
let rpc;

async function run(...args) {
  const { stdout } = await execFileAsync("node", [CLI, ...args], {
    encoding: "utf-8",
    env: { ...process.env, TOOL_CLI_PORT: String(rpc.getPort()) },
  });
  console.log(`$ tool-cli ${args.join(" ")}`);
  console.log(stdout);
  return stdout;
}

try {
  await manager.connectOne("weather", {
    type: "stdio",
    command: "node",
    args: ["dist/test-servers/weather-stdio.js"],
  });

  rpc = new ToolCliRpcServer(manager, 0);
  await rpc.start(console.log);

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

  await rpc.stop();
  await manager.disconnectAll();
  console.log("Smoke test passed ✓");
  process.exit(0);
} catch (err) {
  console.error("Smoke test failed:", err);
  await rpc?.stop().catch(() => {});
  await manager.disconnectAll().catch(() => {});
  process.exit(1);
}
