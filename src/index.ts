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
import {
  McpClientManager,
  McpPolicy,
  isSkillsExtensionEnabled,
  loadMcpConfig,
} from "./mcp/index.js";
import {
  SkillRegistry,
  SkillsExtensionClient,
  createLoadSkillTool,
  discoverSkillsFromServer,
  discoverSkillsViaExtension,
  formatMcpSkillsForPrompt,
  registerMcpToolProxies,
  skillsExtensionDiagnostic,
} from "./skills/index.js";
import {
  ToolCliServer,
  createPolicyToolProvider,
  formatToolCliForPrompt,
} from "./tool-cli/index.js";
import type { ToolProvider } from "./tool-cli/index.js";
import {
  buildExecutionFacilities,
  formatExecutionFacilities,
  publishExecutionFacilities,
} from "./routing/index.js";
import type { BashState, ToolCliState } from "./routing/index.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Report whether the host registers a shell tool.
 *
 * `getAllTools` may be missing on an older host or throw if the runner context
 * is not bound, and neither is evidence that bash is absent — so both collapse
 * to `undiscoverable` rather than a false negative.
 */
function detectBashState(pi: ExtensionAPI): BashState {
  try {
    const bashTool = pi.getAllTools().find((tool) => tool.name === "bash");
    return bashTool ? { kind: "registered", toolName: bashTool.name } : { kind: "absent" };
  } catch (err) {
    return { kind: "undiscoverable", reason: errorMessage(err) };
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.registerFlag("mcp-config", {
    description: "Path to MCP server configuration JSON file",
    type: "string",
  });

  pi.registerFlag("mcp-skills-extension", {
    description: "Enable the DRAFT MCP skills extension (SEP-2640). Unratified; off by default.",
    type: "boolean",
  });

  const hostElicitation = new McpiHostElicitation();
  const hostApproval = new McpiHostApproval();
  const mcpManager = new McpClientManager({ elicitation: hostElicitation });
  const policy = new McpPolicy({ gateway: mcpManager, approvals: hostApproval });
  const skillRegistry = new SkillRegistry();
  const skillsClient = new SkillsExtensionClient({ policy });
  const codeModeManager = new CodeModeManager();
  const { codeSearch, codeExecute } = codeModeManager.createTools();

  // Bridge the shared policy boundary to the ToolProvider interface. tool-cli
  // sees exactly the policy-visible discovered schema set, and every call it
  // makes is re-authorized by the same dispatcher, so it cannot reach a hidden
  // tool by naming it directly.
  const toolProvider: ToolProvider = createPolicyToolProvider(policy);
  const rpcServer = new ToolCliServer(toolProvider);

  // Routing state the prompt reports on. tool-cli is only ever advertised as
  // available once its RPC server has actually started, and a failure is kept
  // here so the agent is told why rather than left to infer it from silence.
  let toolCliState: ToolCliState = {
    kind: "not_started",
    reason: "the session has not finished starting",
  };
  let skillsExtensionEnabled = false;
  let facilitiesPublished = false;

  // Register the load_skill tool so the model can activate MCP skills
  pi.registerTool(createLoadSkillTool({ registry: skillRegistry, policy, skillsClient }));
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

      // Draft extension support is opt-in from either the config file or the
      // CLI flag, and must be decided before any connection is opened because
      // capabilities are fixed at initialize.
      const skillsExtensionEnabledNow =
        pi.getFlag("mcp-skills-extension") === true || isSkillsExtensionEnabled(config);
      skillsExtensionEnabled = skillsExtensionEnabledNow;
      mcpManager.enableSkillsExtension(skillsExtensionEnabledNow);
      if (skillsExtensionEnabledNow) {
        log(skillsExtensionDiagnostic());
      }

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

        // Discover skills from all connected servers. A server that declares
        // the draft extension is served entirely by it: the legacy skill://
        // resource scan is a compatibility fallback for servers that do not,
        // never a second opinion on one that does. An empty extension listing
        // therefore means "no skills right now", not "try the old way".
        for (const serverName of mcpManager.getConnectedServers()) {
          const viaExtension = skillsExtensionEnabled && skillsClient.supports(serverName);
          try {
            if (viaExtension) {
              const result = await discoverSkillsViaExtension(
                policy,
                skillsClient,
                serverName,
                log,
              );
              skillRegistry.registerAll(result.skills);
            } else {
              const skills = await discoverSkillsFromServer(policy, serverName, log);
              skillRegistry.registerAll(skills);
            }
          } catch (err) {
            log(
              `[skills] Failed to discover skills from "${serverName}" via ${
                viaExtension ? "the draft skills extension" : "skill:// resources"
              }: ${(err as Error).message}`,
            );
          }
        }

        for (const collision of skillRegistry.getCollisions()) {
          log(
            `[skills] Name collision on "${collision.name}": "${collision.challenger.serverName}" exposed as "${collision.registeredAs}" (name held by "${collision.incumbent.serverName}")`,
          );
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
          toolCliState = { kind: "started", port };
        } catch (err) {
          const reason = errorMessage(err);
          toolCliState = { kind: "failed", reason };
          // Surfaced to the user here and reported to the agent in the routing
          // section, so a dead RPC server never masquerades as a working one.
          log(`[tool-cli] Failed to start RPC server: ${reason}`);
        }
      } else {
        toolCliState = {
          kind: "not_started",
          reason: "no MCP servers are configured, so there is nothing for it to expose",
        };
      }
      // Code execution remains available even when no MCP servers or callable tools exist.
      codeModeManager.initialize(mcpManager, policy, log);
    } catch (err) {
      const msg = `MCP config error: ${errorMessage(err)}`;
      toolCliState = { kind: "not_started", reason: msg };
      if (ctx.hasUI) {
        ctx.ui.notify(msg, "warning");
      } else {
        console.error(msg);
      }
    }
  });

  // Inject execution routing, MCP skills, tool-cli usage docs, and code mode
  // type hints into the system prompt.
  pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => {
    let extra = "";

    const skills = skillRegistry.getAll();
    const serverCount = mcpManager.getConnectedServers().length;

    // The routing section is emitted on every load, including with zero MCP
    // servers — an agent still needs to know that exact computation and the
    // shell are on the table, and why the MCP-backed facilities are not.
    const facilities = buildExecutionFacilities({
      skills: {
        count: skills.length,
        draftExtensionEnabled: skillsExtensionEnabled,
      },
      codeMode: { active: codeModeManager.isActive },
      toolCli: toolCliState,
      bash: detectBashState(pi),
    });
    // Prefer the host's own facility registry when it grows one. The two paths
    // are mutually exclusive, so the section can never be emitted twice.
    if (!facilitiesPublished) {
      facilitiesPublished = publishExecutionFacilities(pi, facilities);
    }
    if (!facilitiesPublished) {
      extra += formatExecutionFacilities(facilities);
    }

    if (skills.length > 0) {
      extra += formatMcpSkillsForPrompt(skills);
    }

    extra += formatToolCliForPrompt({
      available: toolCliState.kind === "started",
      serverCount,
    });

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
    toolCliState = { kind: "not_started", reason: "the session has shut down" };
    facilitiesPublished = false;
    await rpcServer.stop();
    await mcpManager.disconnectAll();
    skillRegistry.clear();
    policy.reset();
  });
}
