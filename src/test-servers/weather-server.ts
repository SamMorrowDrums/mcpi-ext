/**
 * Test MCP weather server — exposes a weather skill with gated tools.
 *
 * Registers:
 * - skill://weather/SKILL.md — a skill resource with frontmatter
 * - check_weather_for_city — current weather (gated by skill)
 * - check_weekly_forecast_for_city — 7-day forecast (gated by skill)
 * - echo — ungated baseline tool
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const SKILL_CONTENT = `---
name: weather
description: Check current weather and weekly forecasts for any city
allowed-tools:
  - check_weather_for_city
  - check_weekly_forecast_for_city
---

# Weather Forecasting Skill

Use the weather tools to look up conditions for any city.

- **check_weather_for_city** — returns current temperature, conditions, and humidity
- **check_weekly_forecast_for_city** — returns a 7-day forecast summary

Always confirm the city name with the user before calling.
`;

const WEATHER_DATA: Record<string, { temp: number; conditions: string; humidity: number }> = {
  london: { temp: 14, conditions: "Cloudy", humidity: 78 },
  tokyo: { temp: 26, conditions: "Sunny", humidity: 55 },
  "new york": { temp: 22, conditions: "Partly cloudy", humidity: 62 },
  sydney: { temp: 19, conditions: "Clear", humidity: 45 },
};

const FORECAST_DATA: Record<string, string> = {
  london:
    "Mon 13°C Rain | Tue 14°C Cloudy | Wed 15°C Cloudy | Thu 12°C Rain | Fri 14°C Sunny | Sat 16°C Sunny | Sun 15°C Cloudy",
  tokyo:
    "Mon 27°C Sunny | Tue 28°C Sunny | Wed 25°C Rain | Thu 24°C Cloudy | Fri 26°C Sunny | Sat 27°C Sunny | Sun 26°C Partly cloudy",
  "new york":
    "Mon 23°C Sunny | Tue 24°C Sunny | Wed 20°C Thunderstorms | Thu 18°C Cloudy | Fri 21°C Sunny | Sat 22°C Sunny | Sun 23°C Clear",
  sydney:
    "Mon 18°C Clear | Tue 20°C Sunny | Wed 19°C Cloudy | Thu 17°C Rain | Fri 18°C Cloudy | Sat 21°C Sunny | Sun 20°C Clear",
};

export function createWeatherServer(): McpServer {
  const server = new McpServer(
    { name: "test-weather-server", version: "0.1.0" },
    { capabilities: { resources: {} } },
  );

  // Skill resource
  server.registerResource(
    "weather-skill",
    "skill://weather/SKILL.md",
    {
      description: "Weather forecasting skill instructions",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: "skill://weather/SKILL.md",
          text: SKILL_CONTENT,
          mimeType: "text/markdown",
        },
      ],
    }),
  );

  // Tool: current weather (gated by skill)
  server.registerTool(
    "check_weather_for_city",
    {
      description: "Get current weather conditions for a city",
      inputSchema: { city: z.string().describe("City name, e.g. 'London'") },
      outputSchema: {
        temperature: z.number().describe("Temperature in Celsius"),
        conditions: z.string().describe("Weather conditions description"),
        humidity: z.number().describe("Humidity percentage"),
        city: z.string().describe("City name"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ city }) => {
      const data = WEATHER_DATA[city.toLowerCase()];
      if (!data) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No weather data available for "${city}". Try: London, Tokyo, New York, or Sydney.`,
            },
          ],
        };
      }
      const structuredContent = {
        temperature: data.temp,
        conditions: data.conditions,
        humidity: data.humidity,
        city,
      };
      return {
        content: [
          {
            type: "text" as const,
            text: `Weather in ${city}: ${data.conditions}, ${data.temp}°C, humidity ${data.humidity}%`,
          },
        ],
        structuredContent,
      };
    },
  );

  // Tool: weekly forecast (gated by skill)
  server.registerTool(
    "check_weekly_forecast_for_city",
    {
      description: "Get a 7-day weather forecast for a city",
      inputSchema: { city: z.string().describe("City name, e.g. 'Tokyo'") },
      outputSchema: {
        city: z.string().describe("City name"),
        forecast: z.string().describe("7-day forecast summary"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ city }) => {
      const forecast = FORECAST_DATA[city.toLowerCase()];
      if (!forecast) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No forecast data available for "${city}". Try: London, Tokyo, New York, or Sydney.`,
            },
          ],
        };
      }
      const structuredContent = { city, forecast };
      return {
        content: [{ type: "text" as const, text: `Forecast for ${city}: ${forecast}` }],
        structuredContent,
      };
    },
  );

  // Ungated tool (always available, not behind a skill)
  server.registerTool(
    "echo",
    {
      description: "Echoes back the input message",
      inputSchema: { message: z.string() },
      outputSchema: {
        echo: z.string().describe("The echoed message"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ message }) => {
      const structuredContent = { echo: message };
      return {
        content: [{ type: "text" as const, text: `Echo: ${message}` }],
        structuredContent,
      };
    },
  );

  return server;
}
