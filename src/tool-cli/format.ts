/**
 * Format system prompt section advising the agent when and how to use tool-cli.
 *
 * Only included when MCP servers are connected. Tells the agent about
 * progressive discovery via tool-cli as an alternative to skill-based access.
 */
export function formatToolCliForPrompt(serverCount: number): string {
  if (serverCount === 0) return "";

  return `

<tool_cli>
You have access to \`tool-cli\`, a CLI for discovering and calling MCP server tools progressively.

Use tool-cli when:
- No skill covers the task you need to do
- You want to explore what tools are available on a server
- You need ad-hoc access to an MCP tool without loading a full skill

If a skill exists for the task, prefer the skill — it provides workflow instructions and curated tool access.

Usage:
  tool-cli --help                            # List available MCP servers and tool counts
  tool-cli <server>                          # List all tools on a server
  tool-cli <server> <tool>                   # Show full schema for a tool
  tool-cli <server> <tool> '{"key":"value"}' # Call a tool with JSON arguments

tool-cli discovers progressively: start with --help, drill into a server, then a tool. This minimises tokens.
${serverCount} MCP server(s) currently connected.
</tool_cli>`;
}
