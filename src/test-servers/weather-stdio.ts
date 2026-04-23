/**
 * stdio entrypoint for the test weather server.
 * Run with: node dist/test-servers/weather-stdio.js
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWeatherServer } from "./weather-server.js";

const server = createWeatherServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("Test weather server running on stdio");
