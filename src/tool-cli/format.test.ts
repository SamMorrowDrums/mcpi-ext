import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";
import { describe, expect, it } from "vitest";
import { formatToolCliForPrompt, type ToolCliPromptState } from "./format.js";

const BRIDGE_INFO: BridgeInfo = {
  bridgeProtocol: { name: "tool-cli-bridge", major: 1, version: "1.0" },
  serverImplementation: { name: "@sammorrowdrums/tool-cli", version: "1.0.0" },
  operations: [
    "getBridgeInfo",
    "listServers",
    "listTools",
    "describeTool",
    "callTool",
    "listResources",
    "listResourceTemplates",
    "readResource",
  ],
  capabilities: {
    authentication: { required: true, scheme: "bearer" },
    tools: {
      discovery: true,
      calls: true,
      inputSchemaValidation: true,
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
      supportedJsonSchemaDialects: [
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2019-09/schema",
        "http://json-schema.org/draft-07/schema#",
      ],
    },
    resources: { list: true, templates: true, read: true },
    cancellation: { providerAbortSignal: true },
  },
  upstreamMcp: { serverCount: 2 },
};

function verifiedState(): ToolCliPromptState {
  return {
    toolCli: { kind: "verified", port: 7179, bridgeInfo: BRIDGE_INFO },
    bash: { kind: "registered", toolName: "bash" },
  };
}

describe("formatToolCliForPrompt", () => {
  it.each([
    {
      toolCli: { kind: "not_started" as const, reason: "no servers" },
      bash: { kind: "registered" as const, toolName: "bash" },
    },
    {
      toolCli: { kind: "failed" as const, reason: "EADDRINUSE" },
      bash: { kind: "registered" as const, toolName: "bash" },
    },
    {
      toolCli: { kind: "incompatible" as const, reason: "major 2" },
      bash: { kind: "registered" as const, toolName: "bash" },
    },
    {
      toolCli: { kind: "no_bash" as const, reason: "missing" },
      bash: { kind: "absent" as const },
    },
    {
      toolCli: { kind: "verified" as const, port: 7179, bridgeInfo: BRIDGE_INFO },
      bash: { kind: "absent" as const },
    },
  ])("omits usage docs for an unavailable bridge state", (state) => {
    expect(formatToolCliForPrompt(state)).toBe("");
  });

  it("includes tool-cli usage instructions only from verified bridge information", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).toContain("tool-cli");
    expect(result).toContain("<tool_cli_usage_docs>");
    expect(result).toContain("</tool_cli_usage_docs>");
    expect(result).toContain("--help");
    expect(result).toContain("<server>");
    expect(result).toContain("<tool>");
    expect(result).toContain("@sammorrowdrums/tool-cli@1.0.0");
    expect(result).toContain("tool-cli-bridge v1.0");
    expect(result).toContain("operations getBridgeInfo, listServers");
    expect(result).toContain("resource list=true");
    expect(result).toContain("provider cancellation=true");
    expect(result).toContain("2 server(s) reported by the verified bridge handshake");
  });

  it("leads with intent rather than a mechanism description", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).toContain("Use when");
  });

  it("does not assert a fixed precedence over skills", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).not.toContain("prefer the skill");
    expect(result).not.toContain("If a skill exists");
  });

  it("names the bash tool as the invocation path and forbids pseudo-calls", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).toContain("Invoke the bash tool with a command of the form");
    expect(result).toContain("pseudo-call");
    expect(result).toContain("never write out what you expect a command would have printed");
  });

  it("uses a documentation tag that does not read like a tool call", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).not.toContain("<tool_cli>");
    expect(result).not.toContain("</tool_cli>");
  });

  it("includes shell chaining and piping examples", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).toContain("grep");
    expect(result).toContain("|");
    expect(result).toContain("jq");
    expect(result).toContain("xargs");
    expect(result).toContain("prefer one piped command over many separate");
  });

  it("documents policy-authorized resource discovery, reads, and binary output", () => {
    const result = formatToolCliForPrompt(verifiedState());
    expect(result).toContain("tool-cli resource list");
    expect(result).toContain("tool-cli resource templates");
    expect(result).toContain("tool-cli resource read");
    expect(result).toContain("--out /tmp/resource.bin");
  });
});
