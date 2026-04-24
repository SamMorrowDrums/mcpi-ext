import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@mariozechner/pi-coding-agent";
import { CodeModeManager } from "./code-mode/index.js";
import { dockerE2ETool } from "./docker-e2e.js";
import { McpClientManager, loadMcpConfig } from "./mcp/index.js";
import {
  SkillRegistry,
  createLoadSkillTool,
  discoverSkillsFromServer,
  formatMcpSkillsForPrompt,
  registerMcpToolProxies,
} from "./skills/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  const mcpManager = new McpClientManager();
  const skillRegistry = new SkillRegistry();
  const codeModeManager = new CodeModeManager();

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

        // Initialize code mode (Tier 3) for read-only tools with structured output
        codeModeManager.initialize(mcpManager);
        if (codeModeManager.isActive) {
          const { codeSearch, codeExecute } = codeModeManager.createTools();
          pi.registerTool(codeSearch);
          pi.registerTool(codeExecute);
          log(
            `MCP: Code mode active (${codeModeManager.getEligibleTools().length} eligible tool(s))`,
          );
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

  // Inject MCP skills and code mode type hints into the system prompt
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    let additions = "";

    const skills = skillRegistry.getAll();
    if (skills.length > 0) {
      additions += formatMcpSkillsForPrompt(skills);
    }

    if (codeModeManager.isActive) {
      additions += codeModeManager.formatSystemPromptSection();
    }

    if (additions) {
      return { systemPrompt: event.systemPrompt + additions };
    }
  });

  pi.on("session_shutdown", async () => {
    await mcpManager.disconnectAll();
    skillRegistry.clear();
  });
}
