import { describe, it, expect } from "vitest";
import { formatToolCliForPrompt } from "./format.js";

describe("formatToolCliForPrompt", () => {
  it("returns empty string when no servers connected", () => {
    expect(formatToolCliForPrompt(0)).toBe("");
  });

  it("includes tool-cli usage instructions when servers are connected", () => {
    const result = formatToolCliForPrompt(2);
    expect(result).toContain("tool-cli");
    expect(result).toContain("<tool_cli>");
    expect(result).toContain("</tool_cli>");
    expect(result).toContain("--help");
    expect(result).toContain("<server>");
    expect(result).toContain("<tool>");
    expect(result).toContain("2 MCP server(s) currently connected");
  });

  it("advises preferring skills over tool-cli", () => {
    const result = formatToolCliForPrompt(1);
    expect(result).toContain("prefer the skill");
  });
});
