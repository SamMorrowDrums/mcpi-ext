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

Discovery (progressive — only fetch what you need):
  tool-cli --help                            # List MCP servers with tool counts
  tool-cli <server>                          # List all tools on a server
  tool-cli <server> <tool>                   # Show full schema for a tool

Calling tools:
  tool-cli <server> <tool> '{"key":"value"}' # Call a tool with JSON arguments

tool-cli outputs plain text, so it composes naturally with standard shell tools.
Chain calls, filter, and transform results using pipes and bash idioms:

  # Search across tool results
  tool-cli myserver search_docs '{"query":"auth"}' | grep -i "token"

  # Chain tool calls — feed one result into another
  tool-cli myserver list_items '{}' | jq -r '.[0].id' | xargs -I{} tool-cli myserver get_item '{"id":"{}"}'

  # Process multiple items
  for city in London Tokyo Paris; do
    echo "=== $city ==="; tool-cli weather check_weather '{"city":"'$city'"}';
  done

  # Combine with standard tools
  tool-cli myserver export_csv '{"table":"users"}' | sort -t, -k2 | head -20

Prefer piping and chaining over multiple separate tool calls when processing collections or filtering results.
${serverCount} MCP server(s) currently connected.
</tool_cli>`;
}
