import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { McpClientManager } from "./mcp/client-manager.js";
import { McpPolicy } from "./mcp/policy.js";
import { createWeatherServer } from "./test-servers/weather-server.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { discoverSkillsFromServer } from "./skills/discover.js";
import { createLoadSkillTool } from "./skills/load-skill-tool.js";
import { createPolicyToolProvider } from "./tool-cli/provider.js";

/**
 * The composite trajectory.
 *
 * Skills, Code Mode and tool-cli are not three competing answers to the same
 * question, and there is no precedence between them. They are different task
 * shapes over one catalogue, and the point of the design is that a single
 * task can move between them — read a skill's procedure, compute over results
 * in the sandbox, then reach for the shell — without any of them switching
 * the others off.
 *
 * That property is easy to lose by accident. Every regression this file
 * guards against looks locally reasonable: gate the catalogue on the active
 * skill, refuse writes from the sandbox, require `load_skill` before the CLI
 * can see anything. Each one quietly turns a composable surface into a
 * fallback chain, and none of them would be caught by a test that exercised
 * one surface at a time. So these tests deliberately interleave.
 *
 * The shared boundary is the other half of the invariant: whichever surface a
 * call arrives on, it crosses `McpPolicy` exactly once and leaves exactly one
 * audit record tagged with where it came from.
 */
describe("composite trajectory (skills + tool-cli + code mode over one policy)", () => {
  const [weatherClient, weatherServerTransport] = InMemoryTransport.createLinkedPair();
  const [ledgerClient, ledgerServerTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();

  /**
   * A second server, carrying the one thing the weather fixture cannot
   * express: a tool that is not annotated read-only. Two servers behind one
   * policy is also the realistic shape — the boundary has to keep origins
   * apart while letting a single task span both.
   */
  const ledger = new McpServer(
    { name: "test-ledger", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  ledger.registerTool(
    "record_observation",
    {
      description: "Append a weather observation to the ledger",
      inputSchema: { city: z.string(), note: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ city, note }) => ({
      content: [{ type: "text" as const, text: `recorded ${city}: ${note}` }],
    }),
  );

  const manager = new McpClientManager({
    transportFactory: (config) =>
      config.type === "stdio" && config.args?.[0]?.includes("ledger")
        ? ledgerClient
        : weatherClient,
  });
  const registry = new SkillRegistry();
  const confirm = vi.fn().mockResolvedValue(true);
  const policy = new McpPolicy({ gateway: manager, approvals: { confirm } });

  /** Names the weather skill references, and which therefore start deferred. */
  const skillTools = ["check_weather_for_city", "check_weekly_forecast_for_city"];

  beforeAll(async () => {
    await Promise.all([
      server.connect(weatherServerTransport),
      ledger.connect(ledgerServerTransport),
    ]);
    await manager.connectAll({
      mcpServers: {
        "test-weather": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/weather-stdio.js"],
        },
        "test-ledger": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/ledger-stdio.js"],
        },
      },
    });
    const skills = await discoverSkillsFromServer(policy, "test-weather", () => undefined);
    registry.registerAll(skills);
    policy.registerSkills(skills);
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close(), ledger.close()]);
  });

  const auditFor = (toolName: string) =>
    policy.getAuditLog().filter((r) => r.operation === "tool" && r.toolName === toolName);

  it("starts with the skill's tools deferred from the direct surface", () => {
    for (const name of skillTools) expect(policy.isDeferred(name)).toBe(true);
  });

  it("reaches a deferred tool through tool-cli before any skill is loaded", async () => {
    // Deferral is about which definitions the model is shown, not about what
    // may run. tool-cli is a different surface with its own discovery, so a
    // definition being deferred on the direct surface must not hide it here.
    const provider = createPolicyToolProvider(policy);

    const visible = provider.getTools("test-weather").map((t) => t.name);
    for (const name of skillTools) expect(visible).toContain(name);

    const result = await provider.callTool("test-weather", "check_weather_for_city", {
      city: "London",
    });
    expect(result.isError).toBeFalsy();

    // A read crosses without a prompt, and leaves exactly one record.
    expect(confirm).not.toHaveBeenCalled();
    const records = auditFor("check_weather_for_city");
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe("tool-cli");
    expect(records[0].decision).toBe("allowed");
  });

  it("reaches the same tool through code mode before any skill is loaded", async () => {
    // Same catalogue, different surface. Code Mode dispatches through the
    // same policy entry point, so this is the sandbox's view of the boundary.
    const result = await policy.callTool({
      source: "code-mode",
      serverName: "test-weather",
      toolName: "check_weekly_forecast_for_city",
      args: { city: "London" },
    });
    expect(result.result.isError).toBeFalsy();

    const records = auditFor("check_weekly_forecast_for_city");
    expect(records).toHaveLength(1);
    expect(records[0].source).toBe("code-mode");
    expect(records[0].decision).toBe("allowed");
  });

  it("still defers the direct definitions after other surfaces have used them", () => {
    // Using a tool from the sandbox or the shell is not a reason to start
    // spending prompt budget on its schema. Exposure and use are separate.
    for (const name of skillTools) expect(policy.isDeferred(name)).toBe(true);
  });

  it("reveals the direct definitions when the skill loads, without asking", async () => {
    const loadSkill = createLoadSkillTool({ registry, policy });
    const result = await loadSkill.execute(
      "composite-load",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    expect(result.details.error).toBeUndefined();
    expect(result.addedToolNames).toEqual(skillTools);
    for (const name of skillTools) expect(policy.isDeferred(name)).toBe(false);
    // Revealing a schema is a context-engineering act, not an authorization.
    expect(confirm).not.toHaveBeenCalled();
  });

  it("leaves the other surfaces working after a skill has loaded", async () => {
    // The failure this guards against is a design where loading a skill
    // "takes over" the turn. All three stay independently reachable.
    const provider = createPolicyToolProvider(policy);
    expect(provider.getTools("test-weather").map((t) => t.name)).toContain(
      "check_weather_for_city",
    );

    const viaCli = await provider.callTool("test-weather", "check_weather_for_city", {
      city: "Tokyo",
    });
    expect(viaCli.isError).toBeFalsy();

    const viaSandbox = await policy.callTool({
      source: "code-mode",
      serverName: "test-weather",
      toolName: "check_weather_for_city",
      args: { city: "Tokyo" },
    });
    expect(viaSandbox.result.isError).toBeFalsy();

    const viaDirect = await policy.callTool({
      source: "proxy",
      serverName: "test-weather",
      toolName: "check_weather_for_city",
      args: { city: "Tokyo" },
    });
    expect(viaDirect.result.isError).toBeFalsy();
  });

  it("records one crossing per call, tagged with the surface it arrived on", () => {
    const sources = auditFor("check_weather_for_city").map((r) => r.source);
    // One from the pre-skill tool-cli call, then one each for the three
    // surfaces after loading: four crossings, four records, no double-count
    // and no surface bypassing the boundary.
    expect(sources).toEqual(["tool-cli", "tool-cli", "code-mode", "proxy"]);
  });

  it("keeps a tool the skill never referenced reachable from every surface", async () => {
    // `echo` belongs to no skill. If skill state were authorization, this
    // would be unreachable; it is not, so it is reachable everywhere.
    expect(policy.isDeferred("echo")).toBe(false);

    const provider = createPolicyToolProvider(policy);
    expect(provider.getTools("test-weather").map((t) => t.name)).toContain("echo");

    for (const source of ["proxy", "code-mode", "tool-cli"] as const) {
      const result = await policy.callTool({
        source,
        serverName: "test-weather",
        toolName: "echo",
        args: { message: source },
      });
      expect(result.result.isError).toBeFalsy();
    }
  });

  it("asks once per write, on every surface including the sandbox", async () => {
    // `record_observation` is not annotated read-only. This is the shape of a
    // write: the decision is driven by the annotation, not by which surface
    // the call arrived on. Code Mode used to refuse these outright rather
    // than ask, which made the sandbox the one surface that could see a tool
    // it could never finish a task with.
    confirm.mockClear();

    for (const source of ["proxy", "code-mode", "tool-cli"] as const) {
      const result = await policy.callTool({
        source,
        serverName: "test-ledger",
        toolName: "record_observation",
        args: { city: "London", note: source },
      });
      expect(result.result.isError).toBeFalsy();
    }

    // Three calls, three prompts. Not two, and not four: approval is neither
    // skipped for the sandbox nor cached across calls.
    expect(confirm).toHaveBeenCalledTimes(3);

    const writes = policy.getAuditLog().filter((r) => r.toolName === "record_observation");
    expect(writes.map((r) => r.source)).toEqual(["proxy", "code-mode", "tool-cli"]);
    expect(writes.every((r) => r.decision === "allowed")).toBe(true);
  });

  it("declines a sandbox write legibly, as a decision rather than a failure", async () => {
    const declining = vi.fn().mockResolvedValue(false);
    const strictPolicy = new McpPolicy({
      gateway: manager,
      approvals: { confirm: declining },
    });

    await expect(
      strictPolicy.callTool({
        source: "code-mode",
        serverName: "test-ledger",
        toolName: "record_observation",
        args: { city: "London", note: "denied" },
      }),
    ).rejects.toThrow(/approv|denied|declin/i);

    expect(declining).toHaveBeenCalledTimes(1);
    const records = strictPolicy.getAuditLog().filter((r) => r.toolName === "record_observation");
    // A refusal is still exactly one crossing, and it says why.
    expect(records).toHaveLength(1);
    expect(records[0].decision).toBe("denied");
    expect(records[0].source).toBe("code-mode");
  });

  it("keeps the two servers' catalogues separate under one policy", () => {
    const provider = createPolicyToolProvider(policy);
    expect(provider.getServerNames().sort()).toEqual(["test-ledger", "test-weather"]);
    expect(provider.getTools("test-weather").map((t) => t.name)).not.toContain(
      "record_observation",
    );
    expect(provider.getTools("test-ledger").map((t) => t.name)).toEqual(["record_observation"]);
  });

  it("refuses an unknown tool identically on every surface", async () => {
    // Independent discovery must not mean independent trust. A caller can
    // name any string it likes on any surface — tool-cli in particular is
    // authenticated but not trusted — so all of them are refused, before the
    // server is contacted, with the same reason.
    for (const source of ["proxy", "code-mode", "tool-cli"] as const) {
      await expect(
        policy.callTool({
          source,
          serverName: "test-weather",
          toolName: "not_a_real_tool",
          args: {},
        }),
      ).rejects.toThrow(/not discovered/);
    }

    const records = policy.getAuditLog().filter((r) => r.toolName === "not_a_real_tool");
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.decision)).toEqual(["denied", "denied", "denied"]);
    expect(records.map((r) => r.source)).toEqual(["proxy", "code-mode", "tool-cli"]);
  });
});
