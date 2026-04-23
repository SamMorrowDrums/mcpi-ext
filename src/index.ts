import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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
  // Tracks which MCP tools have been activated via load_skill
  const activatedMcpTools = new Set<string>();

  // Register the load_skill tool so the model can activate MCP skills
  pi.registerTool(createLoadSkillTool({ registry: skillRegistry, mcpManager, pi }));

  pi.on("session_start", async (_event, ctx) => {
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

        // Pre-register all MCP tools as Pi tool proxies (visible to model)
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

        if (skillRegistry.size > 0) {
          log(`MCP: ${skillRegistry.size} skill(s) discovered`);
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

  // Inject MCP skills into the system prompt before each agent loop
  pi.on("before_agent_start", async (event) => {
    const skills = skillRegistry.getAll();
    if (skills.length === 0) return;
    const skillsSection = formatMcpSkillsForPrompt(skills);
    return { systemPrompt: event.systemPrompt + skillsSection };
  });

  // Block MCP tools that haven't been activated via load_skill
  pi.on("tool_call", async (event) => {
    if (event.toolName === "load_skill") {
      // After load_skill executes, track its activated tools.
      // We peek at the skill registry to know which tools to unlock.
      const name = (event as { input: { name?: string } }).input.name;
      if (name) {
        const skill = skillRegistry.get(name);
        if (skill) {
          for (const tool of skill.allowedTools) {
            activatedMcpTools.add(tool);
          }
        }
      }
      return;
    }

    // Check if this is a gated MCP tool that hasn't been activated
    const allGated = new Set(skillRegistry.getAll().flatMap((s) => s.allowedTools));
    if (allGated.has(event.toolName) && !activatedMcpTools.has(event.toolName)) {
      // Find which skill gates this tool
      const skill = skillRegistry.getAll().find((s) => s.allowedTools.includes(event.toolName));
      const skillName = skill?.name ?? "unknown";
      return {
        block: true,
        reason: `Tool "${event.toolName}" requires loading the "${skillName}" skill first. Call load_skill({"name": "${skillName}"}) to activate it.`,
      };
    }
  });

  pi.on("session_shutdown", async () => {
    await mcpManager.disconnectAll();
    skillRegistry.clear();
    activatedMcpTools.clear();
  });
}
