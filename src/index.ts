import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@sammorrowdrums/mcpi";
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
import { ToolCliServer, formatToolCliForPrompt } from "./tool-cli/index.js";
import type { ToolProvider } from "./tool-cli/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  const mcpManager = new McpClientManager();
  const skillRegistry = new SkillRegistry();
  const codeModeManager = new CodeModeManager();
  const enabledTools = new Set<string>();
  const gatedToolNames = new Set<string>();

  // Bridge McpClientManager to the ToolProvider interface
  const toolProvider: ToolProvider = {
    getServerNames: () => mcpManager.getConnectedServers(),
    getTools: (server) => mcpManager.getToolsForServer(server),
    async callTool(server, tool, args) {
      const client = mcpManager.getClient(server);
      if (!client) throw new Error(`No client for server "${server}"`);
      const result = await client.callTool({ name: tool, arguments: args });
      return {
        content: result.content as unknown[],
        isError: result.isError === true ? true : undefined,
        structuredContent: result.structuredContent as Record<string, unknown> | undefined,
      };
    },
  };
  const rpcServer = new ToolCliServer(toolProvider);

  // Register the load_skill tool so the model can activate MCP skills
  pi.registerTool(createLoadSkillTool({ registry: skillRegistry, mcpManager, enabledTools }));

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.hasUI) {
      ctx.ui.notify("mcpi-ext loaded", "info");
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

        // Pre-register all MCP tools as deferred Pi tool proxies
        // (in tools array for dispatch but excluded from system prompt)
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
          for (const skill of skillRegistry.getAll()) {
            for (const t of skill.allowedTools) {
              gatedToolNames.add(t);
            }
          }
          log(
            `MCP: ${skillRegistry.size} skill(s) discovered, ${gatedToolNames.size} tool(s) deferred`,
          );
        }

        // Start the tool-cli RPC server for progressive tool discovery
        try {
          const { port, token } = await rpcServer.start(log);
          pi.setEnv("TOOL_CLI_PORT", String(port));
          pi.setEnv("TOOL_CLI_TOKEN", token);
        } catch (err) {
          log(`[tool-cli] Failed to start RPC server: ${(err as Error).message}`);
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

  // Inject MCP skills, tool-cli advice, and code mode type hints into the system prompt
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    let extra = "";

    const skills = skillRegistry.getAll();
    if (skills.length > 0) {
      extra += formatMcpSkillsForPrompt(skills);
    }

    const serverCount = mcpManager.getConnectedServers().length;
    extra += formatToolCliForPrompt(serverCount);

    if (codeModeManager.isActive) {
      extra += codeModeManager.formatSystemPromptSection();
    }

    if (extra.length === 0) return;
    return { systemPrompt: event.systemPrompt + extra };
  });

  // Block deferred MCP tools until their skill is loaded
  pi.on("tool_call", async (event: ToolCallEvent) => {
    const name = "toolName" in event ? event.toolName : undefined;
    if (!name || !gatedToolNames.has(name) || enabledTools.has(name)) return;
    const relevantSkills = skillRegistry
      .getAll()
      .filter((s) => s.allowedTools.includes(name))
      .map((s) => s.name);
    return {
      block: true,
      reason: `Tool "${name}" requires loading a skill first. Call load_skill with one of: ${relevantSkills.join(", ")}`,
    };
  });

  pi.on("session_shutdown", async () => {
    pi.unsetEnv("TOOL_CLI_PORT");
    pi.unsetEnv("TOOL_CLI_TOKEN");
    await rpcServer.stop();
    await mcpManager.disconnectAll();
    skillRegistry.clear();
  });
}
