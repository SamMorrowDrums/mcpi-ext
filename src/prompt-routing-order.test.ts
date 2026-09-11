import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";
import { describe, expect, it } from "vitest";
import { formatTaskShapeSelectionFooter } from "./routing/format.js";
import { formatToolCliForPrompt } from "./tool-cli/format.js";

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
  upstreamMcp: { serverCount: 1 },
};

describe("final task-shape routing instruction", () => {
  it("is appended after Code Mode as the final mcpi-ext prompt addition", () => {
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    const codeMode = source.indexOf("extra += codeModeManager.formatSystemPromptSection()");
    const footer = source.indexOf("extra += formatTaskShapeSelectionFooter()");
    const response = source.indexOf("return { systemPrompt: event.systemPrompt + extra }");

    expect(codeMode).toBeGreaterThan(-1);
    expect(footer).toBeGreaterThan(codeMode);
    expect(response).toBeGreaterThan(footer);
    expect(source.slice(footer, response).match(/extra \+=/g)).toHaveLength(1);
  });

  it("pins the final task-shape instruction", () => {
    expect(formatTaskShapeSelectionFooter()).toMatchInlineSnapshot(`
      "

      <task_shape_selection>
      ## Task-shape selection

      - Standalone MCP lookup: provider-native deferred search, then direct proxy. Do not open bash/tool-cli or Code Mode merely for that call.
      - Computed multi-call work: use Code Mode.
      - Genuine shell, file, or external-program artifact pipeline: use bash + tool-cli (for example, Pandoc).
      - Skill workflow: load the skill; use revealed direct tools for straightforward steps and Code Mode only for needed computation or control flow.

      No universal precedence. Treat unavailable facilities as absent.
      </task_shape_selection>"
    `);
  });

  it("does not present a generic standalone tool call as normal tool-cli usage", () => {
    const result = formatToolCliForPrompt({
      toolCli: { kind: "verified", port: 7179, bridgeInfo: BRIDGE_INFO },
      bash: { kind: "registered", toolName: "bash" },
    });

    expect(result).not.toContain(`tool-cli <server> <tool> '{"key":"value"}'`);
    expect(result).toContain("standalone lookup");
    expect(result).toContain("provider-native direct tools");
  });
});
