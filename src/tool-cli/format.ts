/**
 * Usage documentation for tool-cli.
 *
 * This is the "how", not the "when" — the `<execution_routing>` section decides
 * which facility suits a task, and this section explains how to drive tool-cli
 * once it has been chosen.
 *
 * Only emitted once the local RPC server has actually started. Advertising the
 * commands before that would teach an agent an invocation it cannot perform.
 * The routing section still reports tool-cli's availability either way, so
 * nothing is silently omitted.
 */
export interface ToolCliPromptState {
  /** True only after the local tool-cli RPC server started successfully. */
  available: boolean;
  /** Connected MCP servers, reported to the agent verbatim. */
  serverCount: number;
}

export function formatToolCliForPrompt(state: ToolCliPromptState): string {
  if (!state.available) return "";

  return `

<tool_cli_usage_docs>
Use when you need to reach a specific MCP tool from the shell, or to discover which servers and
tools exist before committing to an approach.

\`tool-cli\` is a program, not a tool you can call. Invoke the bash tool with a command of the form
\`tool-cli ...\`. Never emit \`<tool_cli...>\` markup, a pseudo-call, or any other text that imitates a
tool invocation, and never write out what you expect a command would have printed — run it with the
bash tool and use the real output.

Discovery (progressive — only fetch what you need):
  tool-cli --help                            # List MCP servers with tool counts
  tool-cli <server>                          # List all tools on a server
  tool-cli <server> <tool>                   # Show full schema for a tool

Calling tools:
  tool-cli <server> <tool> '{"key":"value"}' # Call a tool with JSON arguments
  tool-cli <server> <tool> '{}' --out /tmp/result.json  # Save large output to file

tool-cli outputs plain text or JSON. When a tool provides structured output (typed JSON),
tool-cli returns it directly as JSON — use \`jq\` to query fields.
Chain calls, filter, and transform results using pipes and bash idioms:

  # Search across tool results
  tool-cli myserver search_docs '{"query":"auth"}' | grep -i "token"

  # Query structured JSON output with jq
  tool-cli myserver list_issues '{"repo":"owner/repo"}' | jq '.[].title'

  # Chain tool calls — feed one result into another
  tool-cli myserver list_items '{}' | jq -r '.[0].id' | xargs -I{} tool-cli myserver get_item '{"id":"{}"}'

  # Process multiple items
  for city in London Tokyo Paris; do
    echo "=== $city ==="; tool-cli weather check_weather '{"city":"'$city'"}';
  done

  # Combine with standard tools
  tool-cli myserver export_csv '{"table":"users"}' | sort -t, -k2 | head -20

Because tool-cli runs inside a bash command, filtering, joining, or writing results to disk with
ordinary programs is part of the same invocation — prefer one piped command over many separate
calls when processing collections.
Errors go to stderr with exit code 1 — use \`&&\` or \`set -e\` for safe chaining.
${state.serverCount} MCP server(s) currently connected.
</tool_cli_usage_docs>`;
}
