import { InMemoryTransport } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpClientManager } from "../mcp/client-manager.js";
import { McpPolicy } from "../mcp/policy.js";
import { createWeatherServer } from "../test-servers/weather-server.js";
import { CodeModeManager } from "./index.js";

/**
 * Integration test: connect to the test weather server, verify code mode
 * permission metadata, type hint generation, and sandboxed execution with real
 * MCP tool calls returning structuredContent.
 */
describe("code mode integration (weather server)", () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();
  const manager = new McpClientManager({ transportFactory: () => clientTransport });
  const codeMode = new CodeModeManager();

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

    codeMode.initialize(manager, new McpPolicy({ gateway: manager }));
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close()]);
  });

  it("discovers callable read-only tools", () => {
    const eligible = codeMode.getEligibleTools();
    expect(eligible).toHaveLength(3);
    const names = eligible.map((t) => t.name).sort();
    expect(names).toContain("check_weather_for_city");
    expect(names).toContain("check_weekly_forecast_for_city");
    expect(names).toContain("echo");
    expect(codeMode.getDiagnostics()).toEqual({
      totalTools: 3,
      callableTools: 3,
      refusedTools: 0,
      declaredOutputSchemas: 3,
      synthesizedOutputSchemas: 0,
      unavailableOutputSchemas: 0,
    });
  });

  it("generates type hints for eligible tools", () => {
    const hints = codeMode.getTypeHints();
    expect(hints).toContain("declare const codemode");
    expect(hints).toContain("check_weather_for_city");
    expect(hints).toContain("check_weekly_forecast_for_city");
    expect(hints).toContain("echo");
    expect(hints).toContain("listTools");
    expect(hints).toContain("Output schemas: 3 declared, 0 synthesized, 0 unavailable");
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
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("26") }],
      structuredContent: {
        temperature: 26,
        conditions: "Sunny",
        humidity: 55,
        city: "Tokyo",
      },
    });
  });

  it("executes code that chains multiple tool calls", async () => {
    const result = await codeMode.executeCode(`
      const cities = ["London", "Tokyo"];
      const results = [];
      for (const city of cities) {
        const w = await codemode.check_weather_for_city({ city });
        results.push({ city, temp: w.structuredContent.temperature });
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
      return tools.sort();
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
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: "Echo: hello code mode" }],
      structuredContent: { echo: "hello code mode" },
    });
  });

  it("handles tool errors gracefully", async () => {
    const result = await codeMode.executeCode(`
      const w = await codemode.check_weather_for_city({ city: "Atlantis" });
      return w;
    `);

    expect(result.error).toBeUndefined();
    expect(result.result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Output validation error") }],
      isError: true,
    });
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
