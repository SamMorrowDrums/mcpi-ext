import { Type, type Static } from "typebox";

/** Configuration for a stdio-based MCP server (spawns a child process). */
export const StdioServerConfig = Type.Object({
  type: Type.Literal("stdio"),
  command: Type.String({ description: "Executable to run" }),
  args: Type.Optional(Type.Array(Type.String(), { description: "Command-line arguments" })),
  env: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra environment variables for the child process",
    }),
  ),
  cwd: Type.Optional(Type.String({ description: "Working directory for the child process" })),
});

/** Configuration for a remote MCP server (Streamable HTTP). */
export const RemoteServerConfig = Type.Object({
  type: Type.Literal("remote"),
  url: Type.String({ description: "HTTP(S) endpoint URL" }),
  headers: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Extra HTTP headers (e.g. Authorization)",
    }),
  ),
});

/** A single MCP server entry — either stdio or remote. */
export const ServerConfig = Type.Union([StdioServerConfig, RemoteServerConfig]);

/** Top-level configuration file schema. */
export const McpConfig = Type.Object({
  mcpServers: Type.Record(Type.String(), ServerConfig, {
    description: "Named MCP server configurations",
  }),
});

export type StdioServerConfig = Static<typeof StdioServerConfig>;
export type RemoteServerConfig = Static<typeof RemoteServerConfig>;
export type ServerConfig = Static<typeof ServerConfig>;
export type McpConfig = Static<typeof McpConfig>;
