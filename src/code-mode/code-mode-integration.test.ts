import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { McpClientManager } from "../mcp/client-manager.js";
import { CodeModeManager } from "./index.js";

/**
 * Integration test: connect to the test weather server, verify code mode
 * eligibility, type hint generation, and sandboxed execution with real
 * MCP tool calls returning structuredContent.
 */
describe("code mode integration (weather server)", () => {
  const manager = new McpClientManager();
  const codeMode = new CodeModeManager();

  beforeAll(async () => {
    await manager.connectAll({
      mcpServers: {
        "test-weather": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/weather-stdio.js"],
        },
      },
    });

    codeMode.initialize(manager);
  });

  afterAll(async () => {
    await manager.disconnectAll();
  });

  it("discovers eligible tools with readOnlyHint + outputSchema", () => {
    const eligible = codeMode.getEligibleTools();
    expect(eligible.length).toBeGreaterThanOrEqual(2);
    const names = eligible.map((t) => t.name).sort();
    expect(names).toContain("check_weather_for_city");
    expect(names).toContain("check_weekly_forecast_for_city");
    expect(names).toContain("echo");
  });

  it("generates type hints for eligible tools", () => {
    const hints = codeMode.getTypeHints();
    expect(hints).toContain("declare const codemode");
    expect(hints).toContain("check_weather_for_city");
    expect(hints).toContain("check_weekly_forecast_for_city");
    expect(hints).toContain("echo");
    expect(hints).toContain("listTools");
  });

  it("reports as active", () => {
    expect(codeMode.isActive).toBe(true);
  });

  it("generates system prompt section", () => {
    const section = codeMode.formatSystemPromptSection();
    expect(section).toContain("<code_mode>");
    expect(section).toContain("code_search");
    expect(section).toContain("code_execute");
    expect(section).toContain("declare const codemode");
  });

  it("executes code that calls a single tool", async () => {
    const result = await codeMode.executeCode(`
      const weather = await codemode.check_weather_for_city({ city: "Tokyo" });
      return weather;
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toHaveProperty("temperature", 26);
    expect(result.result).toHaveProperty("conditions", "Sunny");
    expect(result.result).toHaveProperty("humidity", 55);
  });

  it("executes code that chains multiple tool calls", async () => {
    const result = await codeMode.executeCode(`
      const cities = ["London", "Tokyo"];
      const results = [];
      for (const city of cities) {
        const w = await codemode.check_weather_for_city({ city });
        results.push({ city, temp: w.temperature });
      }
      return results;
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual([
      { city: "London", temp: 14 },
      { city: "Tokyo", temp: 26 },
    ]);
  });

  it("executes code that uses listTools", async () => {
    const result = await codeMode.executeCode(`
      const tools = await codemode.listTools();
      return tools.map(t => t.name).sort();
    `);

    expect(result.error).toBeUndefined();
    const names = result.result as string[];
    expect(names).toContain("check_weather_for_city");
    expect(names).toContain("echo");
  });

  it("executes code that calls echo tool", async () => {
    const result = await codeMode.executeCode(`
      const r = await codemode.echo({ message: "hello code mode" });
      return r;
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ echo: "hello code mode" });
  });

  it("handles tool errors gracefully", async () => {
    const result = await codeMode.executeCode(`
      const w = await codemode.check_weather_for_city({ city: "Atlantis" });
      return w;
    `);

    // Atlantis isn't in the data — server returns text-only content (no structuredContent)
    // The executor should still return something (parsed text or raw string)
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it("search mode works for tool discovery", async () => {
    const result = await codeMode.searchTools(`
      const tools = await codemode.listTools();
      return tools;
    `);

    expect(result.error).toBeUndefined();
    expect(Array.isArray(result.result)).toBe(true);
  });
});
