import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { dockerE2ETool } from "./docker-e2e.js";
import { McpClientManager, loadMcpConfig } from "./mcp/index.js";
import {
  SkillRegistry,
  createLoadSkillTool,
  discoverSkillsFromServer,
  formatMcpSkillsForPrompt,
  registerMcpToolProxies,
} from "./skills/index.js";
import { ToolCliRpcServer, formatToolCliForPrompt } from "./tool-cli/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  const mcpManager = new McpClientManager();
  const skillRegistry = new SkillRegistry();
  const rpcServer = new ToolCliRpcServer(mcpManager);

  // Register the load_skill tool so the model can activate MCP skills
  pi.registerTool(createLoadSkillTool({ registry: skillRegistry, mcpManager, pi }));

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-mcp-agent loaded", "info");
    }

    const configPath = pi.getFlag("mcp-config") as string | undefined;
    const log = (msg: string) => {
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "info");
      } else {
        console.error(msg);
      }
    };
    try {
      const config = await loadMcpConfig(configPath);
      const serverCount = Object.keys(config.mcpServers).length;
      if (serverCount > 0) {
        await mcpManager.connectAll(config, log);
        const tools = mcpManager.getTools();
        log(
          `MCP: ${mcpManager.getConnectedServers().length} server(s), ${tools.length} tool(s) discovered`,
        );

        // Pre-register all MCP tools as Pi tool proxies (hidden until skill activation)
        const allToolNames = tools.map((t) => t.name);
        registerMcpToolProxies(allToolNames, mcpManager, pi);

        // Discover skills from all connected servers
        for (const serverName of mcpManager.getConnectedServers()) {
          const client = mcpManager.getClient(serverName);
          if (!client) continue;
          try {
            const skills = await discoverSkillsFromServer(client, serverName, log);
            skillRegistry.registerAll(skills);
          } catch (err) {
            log(
              `[skills] Failed to discover skills from "${serverName}": ${(err as Error).message}`,
            );
          }
        }

        // Hide skill-gated MCP tools until load_skill activates them.
        // Requires pi >= 0.70.0 (dynamic tool refresh in agent loop).
        if (skillRegistry.size > 0) {
          const gatedTools = new Set(skillRegistry.getAll().flatMap((s) => s.allowedTools));
          const activeTools = pi.getActiveTools().filter((t: string) => !gatedTools.has(t));
          pi.setActiveTools(activeTools);
          log(`MCP: ${skillRegistry.size} skill(s) discovered, ${gatedTools.size} tool(s) gated`);
        }

        // Start the tool-cli RPC server for progressive tool discovery
        try {
          await rpcServer.start(log);
        } catch (err) {
          log(`[tool-cli] Failed to start RPC server: ${(err as Error).message}`);
        }
      }
    } catch (err) {
      const msg = `MCP config error: ${(err as Error).message}`;
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "warning");
      } else {
        console.error(msg);
      }
    }
  });

  // Inject MCP skills and tool-cli advice into the system prompt before each agent loop
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    let extra = "";

    const skills = skillRegistry.getAll();
    if (skills.length > 0) {
      extra += formatMcpSkillsForPrompt(skills);
    }

    const serverCount = mcpManager.getConnectedServers().length;
    extra += formatToolCliForPrompt(serverCount);

    if (extra.length === 0) return;
    return { systemPrompt: event.systemPrompt + extra };
  });

  pi.on("session_shutdown", async () => {
    await rpcServer.stop();
    await mcpManager.disconnectAll();
    skillRegistry.clear();
  });
}
