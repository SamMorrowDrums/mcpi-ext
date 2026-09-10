import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";
import { getEncoding } from "js-tiktoken";
import { describe, expect, it } from "vitest";
import { loadGithubFixture, withShippedToolsets } from "./code-mode/fixtures.js";
import { deriveNamespaces } from "./code-mode/namespaces.js";
import { renderPromptSection } from "./code-mode/prompt.js";
import type { ExecutionRoutingState } from "./routing/facilities.js";
import { formatExecutionRouting } from "./routing/format.js";
import { formatToolCliForPrompt } from "./tool-cli/format.js";

const PUBLIC_V1_1_0_TOKENS = {
  routing: 1207,
  toolCli: 687,
  codeMode: 1277,
  combined: 3169,
} as const;

const CURRENT_TOKENS = {
  routing: 1095,
  toolCli: 455,
  codeMode: 970,
  combined: 2518,
} as const;

const bridgeInfo: BridgeInfo = {
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

const state: ExecutionRoutingState = {
  skills: { count: 3, draftExtensionEnabled: false },
  codeMode: { active: true },
  toolCli: { kind: "verified", port: 51234, bridgeInfo },
  bash: { kind: "registered", toolName: "bash" },
};

const tokenizer = getEncoding("o200k_base");

function tokens(text: string): number {
  return tokenizer.encode(text).length;
}

describe("fixed turn-zero prompt budget", () => {
  const routing = formatExecutionRouting(state);
  const toolCli = formatToolCliForPrompt({ toolCli: state.toolCli, bash: state.bash });
  const codeMode = renderPromptSection({
    namespaces: deriveNamespaces(withShippedToolsets(loadGithubFixture())),
    sandboxAvailable: true,
  });
  const combined = routing + toolCli + codeMode;

  it("pins actual o200k token counts for each fixed section", () => {
    expect({
      routing: tokens(routing),
      toolCli: tokens(toolCli),
      codeMode: tokens(codeMode),
      combined: tokens(combined),
    }).toEqual(CURRENT_TOKENS);
  });

  it("stays within 150 tokens of the public v1.1.0 combined prompt", () => {
    expect(tokens(combined)).toBeLessThanOrEqual(PUBLIC_V1_1_0_TOKENS.combined + 150);
  });
});
