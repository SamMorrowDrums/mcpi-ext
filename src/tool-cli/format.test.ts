import { describe, it, expect } from "vitest";
import { formatToolCliForPrompt } from "./format.js";

describe("formatToolCliForPrompt", () => {
  it("omits the usage docs until the RPC server has started", () => {
    // Availability, not server count, gates the docs: teaching an invocation
    // the agent cannot perform is worse than saying nothing here. The routing
    // section still reports tool-cli's state in both cases.
    expect(formatToolCliForPrompt({ available: false, serverCount: 0 })).toBe("");
    expect(formatToolCliForPrompt({ available: false, serverCount: 3 })).toBe("");
  });

  it("includes tool-cli usage instructions once available", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 2 });
    expect(result).toContain("tool-cli");
    expect(result).toContain("<tool_cli_usage_docs>");
    expect(result).toContain("</tool_cli_usage_docs>");
    expect(result).toContain("--help");
    expect(result).toContain("<server>");
    expect(result).toContain("<tool>");
    expect(result).toContain("2 MCP server(s) currently connected");
  });

  it("leads with intent rather than a mechanism description", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 1 });
    expect(result).toContain("Use when");
  });

  it("does not assert a fixed precedence over skills", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 1 });
    expect(result).not.toContain("prefer the skill");
    expect(result).not.toContain("If a skill exists");
  });

  it("names the bash tool as the invocation path and forbids pseudo-calls", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 1 });
    expect(result).toContain("Invoke the bash tool with a command of the form");
    expect(result).toContain("pseudo-call");
    expect(result).toContain("never write out what you expect a command would have printed");
  });

  it("uses a documentation tag that does not read like a tool call", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 1 });
    expect(result).not.toContain("<tool_cli>");
    expect(result).not.toContain("</tool_cli>");
  });

  it("includes shell chaining and piping examples", () => {
    const result = formatToolCliForPrompt({ available: true, serverCount: 1 });
    expect(result).toContain("grep");
    expect(result).toContain("|");
    expect(result).toContain("jq");
    expect(result).toContain("xargs");
    expect(result).toContain("prefer one piped command over many separate");
  });
});
