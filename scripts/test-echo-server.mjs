#!/usr/bin/env node
/**
 * Minimal MCP server for integration testing.
 * Exposes a single "echo" tool that returns its input.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "test-echo-server",
  version: "0.1.0",
});

server.registerTool(
  "echo",
  {
    description: "Echoes back the input message",
    inputSchema: { message: z.string() },
    annotations: { readOnlyHint: true },
  },
  async ({ message }) => ({
    content: [{ type: "text", text: message }],
  }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
