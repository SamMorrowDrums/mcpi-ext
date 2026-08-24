import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
} from "@sammorrowdrums/mcpi";
import { CodeModeManager } from "./code-mode/index.js";
import { dockerE2ETool } from "./docker-e2e.js";
import { McpiHostApproval } from "./mcp/host-approval.js";
import { McpiHostElicitation } from "./mcp/host-elicitation.js";
import { McpClientManager, McpPolicy, loadMcpConfig } from "./mcp/index.js";
import {
  SkillRegistry,
  createLoadSkillTool,
  discoverSkillsFromServer,
  formatMcpSkillsForPrompt,
  registerMcpToolProxies,
} from "./skills/index.js";
import {
  ToolCliServer,
  createPolicyToolProvider,
  formatToolCliForPrompt,
} from "./tool-cli/index.js";
import type { ToolProvider } from "./tool-cli/index.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  const hostElicitation = new McpiHostElicitation();
  const hostApproval = new McpiHostApproval();
  const mcpManager = new McpClientManager({ elicitation: hostElicitation });
  const policy = new McpPolicy({ gateway: mcpManager, approvals: hostApproval });
  const skillRegistry = new SkillRegistry();
  const codeModeManager = new CodeModeManager();
  const { codeSearch, codeExecute } = codeModeManager.createTools();

  // Bridge the shared policy boundary to the ToolProvider interface. tool-cli
  // sees exactly the policy-visible discovered schema set, and every call it
  // makes is re-authorized by the same dispatcher, so it cannot reach a hidden
  // tool by naming it directly.
  const toolProvider: ToolProvider = createPolicyToolProvider(policy);
  const rpcServer = new ToolCliServer(toolProvider);

  // Register the load_skill tool so the model can activate MCP skills
  pi.registerTool(createLoadSkillTool({ registry: skillRegistry, policy }));
  pi.registerTool(codeSearch);
  pi.registerTool(codeExecute);

  pi.on("session_start", async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    hostElicitation.setContext(ctx);
    hostApproval.setContext(ctx);
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
        registerMcpToolProxies(allToolNames, mcpManager, policy, pi);

        // Discover skills from all connected servers
        for (const serverName of mcpManager.getConnectedServers()) {
          try {
            const skills = await discoverSkillsFromServer(policy, serverName, log);
            skillRegistry.registerAll(skills);
          } catch (err) {
            log(
              `[skills] Failed to discover skills from "${serverName}": ${(err as Error).message}`,
            );
          }
        }

        // Hand the discovered skills to the policy so their tools are gated
        // everywhere, not just on the mcpi dispatch path.
        policy.registerSkills(skillRegistry.getAll());

        if (skillRegistry.size > 0) {
          log(
            `MCP: ${skillRegistry.size} skill(s) discovered, ${policy.getGatedToolNames().length} tool(s) deferred`,
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
      }
      // Code execution remains available even when no MCP servers or callable tools exist.
      codeModeManager.initialize(mcpManager, policy, log);
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
      codeModeManager.refresh();
      extra += codeModeManager.formatSystemPromptSection();
    }

    if (extra.length === 0) return;
    return { systemPrompt: event.systemPrompt + extra };
  });

  // Block deferred MCP tools until their skill is loaded. The policy owns the
  // decision so mcpi dispatch and the RPC path cannot disagree.
  pi.on("tool_call", async (event: ToolCallEvent) => {
    const name = "toolName" in event ? event.toolName : undefined;
    if (!name || !policy.isGated(name)) return;
    const relevantSkills = policy.getGatingSkills(name);
    return {
      block: true,
      reason: `Tool "${name}" requires loading a skill first. Call load_skill with one of: ${relevantSkills.join(", ")}`,
    };
  });

  pi.on("session_shutdown", async () => {
    hostElicitation.setContext(undefined);
    hostApproval.setContext(undefined);
    pi.unsetEnv("TOOL_CLI_PORT");
    pi.unsetEnv("TOOL_CLI_TOKEN");
    await rpcServer.stop();
    await mcpManager.disconnectAll();
    skillRegistry.clear();
    policy.reset();
  });
}
