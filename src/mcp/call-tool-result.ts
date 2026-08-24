import type { AgentToolResult } from "@sammorrowdrums/mcpi";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { CallToolResult as ToolCliCallToolResult } from "@sammorrowdrums/tool-cli";

export interface TerminalCallToolResult {
  readonly kind: "terminal";
  readonly result: CallToolResult;
}

export function adaptTerminalCallToolResult(result: CallToolResult): TerminalCallToolResult {
  return { kind: "terminal", result };
}

export function renderTerminalCallToolResult(
  terminal: TerminalCallToolResult,
): AgentToolResult<CallToolResult> {
  const content: AgentToolResult<CallToolResult>["content"] = [];

  if (terminal.result.isError) {
    content.push({ type: "text", text: "MCP tool reported an error." });
  }

  for (const block of terminal.result.content) {
    switch (block.type) {
      case "text":
        content.push({ type: "text", text: block.text });
        break;
      case "image":
        content.push({ type: "image", data: block.data, mimeType: block.mimeType });
        break;
      case "audio":
        content.push({
          type: "text",
          text: `[MCP audio: ${block.mimeType}; base64 payload preserved in result details]`,
        });
        break;
      case "resource_link":
        content.push({
          type: "text",
          text: formatResourceLink(block),
        });
        break;
      case "resource":
        content.push({
          type: "text",
          text: formatEmbeddedResource(block),
        });
        break;
      default:
        content.push({ type: "text", text: JSON.stringify(block, null, 2) });
    }
  }

  if (terminal.result.structuredContent !== undefined) {
    content.push({
      type: "text",
      text: `Structured content:\n${JSON.stringify(terminal.result.structuredContent, null, 2)}`,
    });
  }

  if (content.length === 0) {
    content.push({ type: "text", text: terminal.result.isError ? "MCP tool failed." : "" });
  }

  return {
    content,
    details: terminal.result,
  };
}

/**
 * tool-cli 0.3's public type predates arbitrary JSON structuredContent. The RPC
 * server serializes the value unchanged; keep this assertion isolated at that
 * compatibility boundary until tool-cli widens its public contract.
 */
export function toToolCliCallToolResult(terminal: TerminalCallToolResult): ToolCliCallToolResult {
  return terminal.result as ToolCliCallToolResult;
}

function formatResourceLink(
  block: Extract<CallToolResult["content"][number], { type: "resource_link" }>,
): string {
  const label = block.title ?? block.name ?? block.uri;
  const details = [block.mimeType, block.description].filter(Boolean).join("; ");
  return `[MCP resource link: ${label}] ${block.uri}${details ? ` (${details})` : ""}`;
}

function formatEmbeddedResource(
  block: Extract<CallToolResult["content"][number], { type: "resource" }>,
): string {
  const resource = block.resource;
  if ("text" in resource) {
    return `[MCP embedded resource: ${resource.uri}]\n${resource.text}`;
  }
  return `[MCP embedded resource: ${resource.uri}; ${resource.mimeType ?? "binary"} blob preserved in result details]`;
}
