import type {
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
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
  startToolCliBridge,
  withholdToolCliCredentials,
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
 * Report whether the host currently exposes a shell tool to the agent.
 *
 * `getActiveTools` may be missing on an older host or throw if the runner context
 * is not bound, and neither is evidence that bash is absent — so both collapse
 * to `undiscoverable` rather than a false negative.
 */
export function detectBashState(pi: ExtensionAPI): BashState {
  try {
    return pi.getActiveTools().includes("bash")
      ? { kind: "registered", toolName: "bash" }
      : { kind: "absent" };
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

  pi.registerFlag("no-mcp-skills-extension", {
    description:
      "Do not negotiate the DRAFT MCP skills extension (SEP-2640) with servers that declare it. " +
      "Negotiation is on by default; this is the explicit opt-out.",
    type: "boolean",
  });

  pi.registerFlag("mcp-skills-extension", {
    description:
      "Deprecated no-op: the DRAFT MCP skills extension (SEP-2640) is negotiated by default. " +
      "Use --no-mcp-skills-extension to opt out.",
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
  const toolProvider: ToolProvider = createPolicyToolProvider(policy, { upstream: mcpManager });
  const rpcServer = new ToolCliServer(toolProvider);

  // Routing state the prompt reports on. tool-cli is only ever advertised after
  // a compatible authenticated v1 handshake and confirmed bash availability.
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
    withholdToolCliCredentials(pi);
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

      // Draft extension negotiation is on by default and must be decided before
      // any connection is opened, because capabilities are fixed at initialize.
      // The opt-out is a distinct flag rather than `--mcp-skills-extension=false`
      // because a registered boolean flag reads back as `true` whenever it is
      // present, so a negated value could not be expressed on that name.
      const skillsExtensionEnabledNow =
        pi.getFlag("no-mcp-skills-extension") === true ? false : isSkillsExtensionEnabled(config);
      skillsExtensionEnabled = skillsExtensionEnabledNow;
      mcpManager.enableSkillsExtension(skillsExtensionEnabledNow);
      if (skillsExtensionEnabledNow) {
        log(skillsExtensionDiagnostic());
      } else {
        log("[skills] SEP-2640 Skills Extension negotiation disabled by explicit opt-out.");
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
          if (viaExtension) {
            // SEP-2640 is a draft. It is on by default because a server that
            // declares it has already asked for it, and requiring a second
            // opt-in from the user only produces servers whose skills silently
            // never appear. Default-on for an unratified wire contract is only
            // defensible if it is stated out loud and can be switched off, so
            // this line names the draft and the opt-out every time it is used.
            log(
              `[skills] "${serverName}" declares the draft (unratified) SEP-2640 skills extension; negotiating it instead of skill:// discovery.`,
            );
          }
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

        // Hand the discovered skills to the policy so it knows which direct
        // proxy definitions stay deferred until a skill references them. This
        // is exposure bookkeeping only — it never grants or withholds
        // authorization, and it never affects Code Mode or tool-cli.
        policy.registerSkills(skillRegistry.getAll());

        if (skillRegistry.size > 0) {
          log(
            `MCP: ${skillRegistry.size} skill(s) discovered, ${policy.getDeferredToolNames().length} direct tool definition(s) deferred`,
          );
        }

        toolCliState = await startToolCliBridge({
          bash: detectBashState(pi),
          server: rpcServer,
          environment: pi,
          log,
        });
      } else {
        toolCliState = {
          kind: "not_started",
          reason: "no MCP servers are configured, so there is nothing for it to expose",
        };
      }
      // Code execution remains available even when no MCP servers or callable tools exist.
      codeModeManager.initialize(mcpManager, policy, log);
      // Probe the optional native sandbox backend once, so routing can state
      // plainly whether code mode can run rather than assuming it can.
      await codeModeManager.probeSandbox();
    } catch (err) {
      withholdToolCliCredentials(pi);
      await rpcServer.stop();
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
    const bashState = detectBashState(pi);
    // Idempotent after the first resolution; covers hosts that reach
    // before_agent_start without a preceding successful session_start.
    const sandbox = await codeModeManager.probeSandbox();

    // The routing section is emitted on every load, including with zero MCP
    // servers — an agent still needs to know that exact computation and the
    // shell are on the table, and why the MCP-backed facilities are not.
    const facilities = buildExecutionFacilities({
      skills: {
        count: skills.length,
        draftExtensionEnabled: skillsExtensionEnabled,
      },
      codeMode: { active: codeModeManager.isActive, reason: sandbox.reason },
      toolCli: toolCliState,
      bash: bashState,
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

    extra += formatToolCliForPrompt({ toolCli: toolCliState, bash: bashState });

    if (codeModeManager.isActive) {
      codeModeManager.refresh();
      extra += codeModeManager.formatSystemPromptSection();
    }

    if (extra.length === 0) return;
    return { systemPrompt: event.systemPrompt + extra };
  });

  // Deliberately no `tool_call` gate on deferred MCP tools. Deferral is
  // visibility, not authorization: if a provider's grammar lets the model name
  // a deferred tool, the call is legitimate and must reach the policy, which
  // decides on annotations alone. Blocking here would turn a presentation
  // choice into a permission rule and would also strand Code Mode and tool-cli.

  pi.on("session_shutdown", async () => {
    hostElicitation.setContext(undefined);
    hostApproval.setContext(undefined);
    withholdToolCliCredentials(pi);
    toolCliState = { kind: "not_started", reason: "the session has shut down" };
    facilitiesPublished = false;
    await rpcServer.stop();
    await mcpManager.disconnectAll();
    skillRegistry.clear();
    policy.reset();
  });
}
