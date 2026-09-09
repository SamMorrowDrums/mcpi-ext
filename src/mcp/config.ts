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
  experimental: Type.Optional(
    Type.Object(
      {
        skillsExtension: Type.Optional(
          Type.Boolean({
            description:
              "Opt in to the DRAFT MCP skills extension (SEP-2640). Unratified and subject to change; off by default.",
          }),
        ),
      },
      { description: "Opt-in support for unratified MCP proposals" },
    ),
  ),
});

export type StdioServerConfig = Static<typeof StdioServerConfig>;
export type RemoteServerConfig = Static<typeof RemoteServerConfig>;
export type ServerConfig = Static<typeof ServerConfig>;
export type McpConfig = Static<typeof McpConfig>;

/**
 * Whether the draft skills extension is negotiated with servers that declare it.
 *
 * Defaults to **on**. Progressive discovery is the product: a server that
 * declares `io.modelcontextprotocol/skills` has asked to be discovered
 * progressively, and requiring the user to also pass a flag makes the default
 * experience the degraded one. Negotiation stays strictly opt-in *per server* —
 * the policy re-reads each server's declared settings before every extension
 * request, so a server that never declared the extension is never spoken to in
 * it, whatever this returns.
 *
 * SEP-2640 is still a draft, so the opt-out is explicit
 * (`experimental.skillsExtension: false`, or `--no-mcp-skills-extension`) and
 * the draft status is surfaced as a diagnostic whenever it is in use.
 */
export function isSkillsExtensionEnabled(config: Pick<McpConfig, "experimental">): boolean {
  return config.experimental?.skillsExtension !== false;
}
