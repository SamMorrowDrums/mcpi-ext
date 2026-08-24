import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { InMemoryTransport, type Client } from "@modelcontextprotocol/client";
import { McpClientManager } from "../mcp/client-manager.js";
import { createWeatherServer } from "../test-servers/weather-server.js";
import { SkillRegistry } from "./skill-registry.js";
import { discoverSkillsFromServer } from "./discover.js";
import { formatMcpSkillsForPrompt } from "./format.js";
import { createLoadSkillTool } from "./load-skill-tool.js";

/**
 * Integration test: connect to the test weather server in memory,
 * discover skills, load a skill, verify tool schemas in result, call a gated tool.
 */
describe("skill integration (weather server)", () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();
  const manager = new McpClientManager({ transportFactory: () => clientTransport });
  const registry = new SkillRegistry();
  const enabledTools = new Set<string>();
  let client: Client;

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

    const c = manager.getClient("test-weather");
    if (!c) throw new Error("Expected client for test-weather");
    client = c;
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close()]);
  });

  it("connects and discovers tools", () => {
    expect(manager.getConnectedServers()).toEqual(["test-weather"]);
    const tools = manager.getTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "check_weather_for_city",
      "check_weekly_forecast_for_city",
      "echo",
    ]);
  });

  it("discovers skill:// resources with frontmatter", async () => {
    const skills = await discoverSkillsFromServer(client, "test-weather");

    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("weather");
    expect(skills[0].description).toBe("Check current weather and weekly forecasts for any city");
    expect(skills[0].allowedTools).toEqual([
      "check_weather_for_city",
      "check_weekly_forecast_for_city",
    ]);
    expect(skills[0].uri).toBe("skill://weather/SKILL.md");
    expect(skills[0].serverName).toBe("test-weather");

    registry.registerAll(skills);
  });

  it("formats skills for system prompt", () => {
    const prompt = formatMcpSkillsForPrompt(registry.getAll());
    expect(prompt).toContain("<available_mcp_skills>");
    expect(prompt).toContain("<name>weather</name>");
    expect(prompt).toContain("load_skill");
  });

  it("load_skill returns skill body and reports activated tools", async () => {
    const tool = createLoadSkillTool({
      registry,
      mcpManager: manager,
      enabledTools,
    });

    const result = await tool.execute(
      "call-1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    expect(result.details.error).toBeUndefined();
    expect(result.details.activatedTools).toEqual([
      "check_weather_for_city",
      "check_weekly_forecast_for_city",
    ]);
    const text = result.content[0];
    expect(text.type).toBe("text");
    // Skill body should mention the tools
    expect("text" in text && text.text).toContain("check_weather_for_city");
    // Tools should now be in enabledTools set
    expect(enabledTools.has("check_weather_for_city")).toBe(true);
    expect(enabledTools.has("check_weekly_forecast_for_city")).toBe(true);
  });

  it("calls gated tools via MCP client", async () => {
    const weather = await client.callTool({
      name: "check_weather_for_city",
      arguments: { city: "Tokyo" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((weather.content as any)[0].text).toContain("26");
    expect(weather.structuredContent).toEqual({
      temperature: 26,
      conditions: "Sunny",
      humidity: 55,
      city: "Tokyo",
    });

    const forecast = await client.callTool({
      name: "check_weekly_forecast_for_city",
      arguments: { city: "London" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((forecast.content as any)[0].text).toContain("London");
    expect(forecast.structuredContent).toHaveProperty("city", "London");
    expect(forecast.structuredContent).toHaveProperty("forecast");
  });

  it("load_skill returns error for unknown skill", async () => {
    const tool = createLoadSkillTool({
      registry,
      mcpManager: manager,
      enabledTools,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await tool.execute("call-2", { name: "nope" }, undefined, undefined, {} as any);
    expect(result.details.error).toBe("not_found");
    const text = result.content[0];
    expect("text" in text && text.text).toContain("not found");
  });
});
