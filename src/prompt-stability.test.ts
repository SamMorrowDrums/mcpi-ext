import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpClientManager } from "./mcp/client-manager.js";
import { McpPolicy } from "./mcp/policy.js";
import { createWeatherServer } from "./test-servers/weather-server.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { discoverSkillsFromServer } from "./skills/discover.js";
import { createLoadSkillTool } from "./skills/load-skill-tool.js";
import { formatMcpSkillsForPrompt } from "./skills/format.js";
import { formatExecutionRouting } from "./routing/format.js";
import type { ExecutionRoutingState } from "./routing/facilities.js";

/**
 * Activation must not move the cached prefix.
 *
 * A conversation's tool array and system prompt are the cached prefix of
 * every request in it. Rewriting either one to reveal a tool invalidates that
 * cache for the whole turn and every turn after — paying repeatedly, in
 * latency and tokens, for something the transcript can carry for free.
 *
 * This is not hypothetical. The obvious way to implement activation is
 * `setActiveTools`, and the published host implementation of that call
 * reassigns `state.tools` *and* rebuilds the system prompt. It would work,
 * visibly, while quietly destroying the property the whole design exists to
 * protect. So activation goes out as `addedToolNames` on the tool result and
 * is expanded from the conversation tail instead, and these tests hold the
 * line: after a skill loads, nothing the model sees at the front of the
 * request has changed.
 */
describe("prompt and tool-array stability across activation", () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();
  const manager = new McpClientManager({ transportFactory: () => clientTransport });
  const registry = new SkillRegistry();
  const policy = new McpPolicy({
    gateway: manager,
    approvals: { confirm: vi.fn().mockResolvedValue(true) },
  });

  const routingState: ExecutionRoutingState = {
    skills: { count: 1, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: { kind: "not_started", reason: "not started in this test" },
    bash: { kind: "registered", toolName: "bash" },
  };

  beforeAll(async () => {
    await server.connect(serverTransport);
    await manager.connectAll({
      mcpServers: {
        "test-weather": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/weather-stdio.js"],
        },
      },
    });
    const skills = await discoverSkillsFromServer(policy, "test-weather", () => undefined);
    registry.registerAll(skills);
    policy.registerSkills(skills);
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close()]);
  });

  /** Everything mcpi-ext contributes to the cached prefix, as bytes. */
  function prefix(): string {
    return [
      formatExecutionRouting(routingState),
      formatMcpSkillsForPrompt(registry.getAll()),
      JSON.stringify(policy.getDiscoverableTools("test-weather")),
    ].join("\n");
  }

  it("renders the same bytes for the same state", () => {
    // Determinism first: without this, comparing before and after proves
    // nothing, because any difference could be incidental ordering.
    expect(prefix()).toBe(prefix());
  });

  it("leaves the prefix byte-identical after a skill loads", async () => {
    const before = prefix();

    const loadSkill = createLoadSkillTool({ registry, policy });
    const result = await loadSkill.execute(
      "stability-1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    // The activation really did happen — this is not passing by doing nothing.
    expect(result.addedToolNames?.length).toBeGreaterThan(0);
    expect(policy.isDeferred("check_weather_for_city")).toBe(false);

    // ...and it cost nothing at the front of the request. The revealed
    // definitions ride the transcript, not the prompt.
    expect(prefix()).toBe(before);
  });

  it("stays byte-identical across repeat activations and later calls", async () => {
    const before = prefix();
    const loadSkill = createLoadSkillTool({ registry, policy });

    for (const id of ["stability-2", "stability-3"]) {
      await loadSkill.execute(
        id,
        { name: "weather" },
        undefined,
        undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {} as any,
      );
    }

    await policy.callTool({
      source: "proxy",
      serverName: "test-weather",
      toolName: "check_weather_for_city",
      args: { city: "London" },
    });

    // Neither reloading a skill nor actually using what it revealed moves the
    // prefix. Only the transcript grows.
    expect(prefix()).toBe(before);
  });

  it("touches no host tool-registry API while activating", async () => {
    // The failure mode this guards is specific: reaching for `setActiveTools`
    // to reveal definitions. The published host implementation of that call
    // reassigns the tool array and rebuilds the system prompt, so calling it
    // would invalidate both cached prefixes. `load_skill` is handed a context
    // that records every property touched, and must not reach for any of it.
    const touched: string[] = [];
    const spyContext = new Proxy(
      {},
      {
        get(_target, property) {
          if (typeof property === "string") touched.push(property);
          return undefined;
        },
      },
    );

    const loadSkill = createLoadSkillTool({ registry, policy });
    const result = await loadSkill.execute(
      "stability-4",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spyContext as any,
    );

    expect(result.addedToolNames?.length).toBeGreaterThan(0);
    for (const mutator of ["setActiveTools", "registerTool", "setSystemPrompt", "getActiveTools"]) {
      expect(touched).not.toContain(mutator);
    }
  });
});
