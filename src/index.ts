import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dockerE2ETool } from "./docker-e2e.js";
import { McpClientManager, loadMcpConfig } from "./mcp/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  const mcpManager = new McpClientManager();

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-mcp-agent loaded", "info");
    }

    const configPath = pi.getFlag("mcp-config") as string | undefined;
    try {
      const config = await loadMcpConfig(configPath);
      const serverCount = Object.keys(config.mcpServers).length;
      if (serverCount > 0) {
        await mcpManager.connectAll(config, (msg) => {
          if (ctx.hasUI) {
            ctx.ui.notify(msg, "info");
          }
        });
        const tools = mcpManager.getTools();
        if (ctx.hasUI) {
          ctx.ui.notify(
            `MCP: ${mcpManager.getConnectedServers().length} server(s), ${tools.length} tool(s) discovered`,
            "info",
          );
        }
      }
    } catch (err) {
      const msg = `MCP config error: ${(err as Error).message}`;
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "warning");
      }
    }
  });

  pi.on("session_shutdown", async () => {
    await mcpManager.disconnectAll();
  });
}
