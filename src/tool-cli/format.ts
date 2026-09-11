import type { BashState, ToolCliState } from "../routing/facilities.js";

/**
 * Usage documentation for tool-cli.
 *
 * This is primarily the "how": the final `<task_shape_selection>` footer decides
 * which facility suits a task, while this section explains how to drive
 * tool-cli once a shell or artifact pipeline has actually selected it.
 *
 * Only emitted once the local RPC server has actually started. Advertising the
 * commands before that would teach an agent an invocation it cannot perform.
 * The routing section still reports tool-cli's availability either way, so
 * nothing is silently omitted.
 */
export interface ToolCliPromptState {
  /** Authenticated bridge state, including the verified v1 handshake metadata. */
  toolCli: ToolCliState;
  /** tool-cli is a shell program, so a registered bash tool is mandatory. */
  bash: BashState;
}

export function formatToolCliForPrompt(state: ToolCliPromptState): string {
  if (state.toolCli.kind !== "verified" || state.bash.kind !== "registered") return "";

  const { bridgeInfo } = state.toolCli;
  const upstreamServerCount = readUpstreamServerCount(bridgeInfo.upstreamMcp);

  return `

<tool_cli_usage_docs>
\`tool-cli\` is a program, not a tool you can call. Invoke the bash tool with a command of the form
\`tool-cli ...\`. Never emit \`<tool_cli...>\` markup, a pseudo-call, or any other text that imitates a
tool invocation, and never write out what you expect a command would have printed — run it with the
bash tool and use the real output.

Do not use tool-cli for a standalone lookup when provider-native direct tools are available.

Discovery (progressive — only fetch what you need):
  tool-cli --help                            # List MCP servers with tool counts
  tool-cli <server>                          # List all tools on a server
  tool-cli <server> <tool>                   # Show full schema for a tool

Resources:
  tool-cli resource list --server <server>
  tool-cli resource templates --server <server>
  tool-cli resource read --server <server> <uri>
  tool-cli resource read --server <server> <uri> --out ./resource.bin

tool-cli accepts JSON arguments and outputs plain text or JSON. Use it in genuine shell, file, or
external-program pipelines:
  tool-cli docs export_markdown '{"report":"weekly"}' | pandoc --from markdown --output weekly-report.pdf
  tool-cli myserver export_csv '{"table":"users"}' --out ./users.csv

Errors go to stderr with exit code 1 — use \`&&\` or \`set -e\` for safe chaining.
Verified bridge: ${bridgeInfo.serverImplementation.name}@${bridgeInfo.serverImplementation.version};
protocol ${bridgeInfo.bridgeProtocol.name} v${bridgeInfo.bridgeProtocol.version}; authenticated bearer RPC;
operations ${bridgeInfo.operations.join(", ")}.
Verified capabilities: tool discovery=${bridgeInfo.capabilities.tools.discovery}, calls=${bridgeInfo.capabilities.tools.calls},
schema validation=${bridgeInfo.capabilities.tools.inputSchemaValidation}; resource list=${bridgeInfo.capabilities.resources.list},
templates=${bridgeInfo.capabilities.resources.templates}, read=${bridgeInfo.capabilities.resources.read};
provider cancellation=${bridgeInfo.capabilities.cancellation.providerAbortSignal}.
Upstream MCP summary: ${upstreamServerCount} server(s) reported by the verified bridge handshake.
</tool_cli_usage_docs>`;
}

function readUpstreamServerCount(upstream: unknown): number | "unknown" {
  if (upstream === null || typeof upstream !== "object" || Array.isArray(upstream)) {
    return "unknown";
  }
  const count = Reflect.get(upstream, "serverCount");
  return typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : "unknown";
}
