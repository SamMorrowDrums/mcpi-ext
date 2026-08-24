import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  adaptTerminalCallToolResult,
  renderTerminalCallToolResult,
  toToolCliCallToolResult,
} from "./call-tool-result.js";

describe("terminal CallToolResult adapter", () => {
  it("preserves every MCP content kind, scalar structured content, and isError", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "plain text" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "file:///guide.md",
          name: "guide",
          title: "Guide",
          description: "Reference",
          mimeType: "text/markdown",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///embedded.txt",
            text: "embedded text",
            mimeType: "text/plain",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "file:///data.bin",
            blob: "AAEC",
            mimeType: "application/octet-stream",
          },
        },
      ],
      structuredContent: false,
      isError: true,
    };

    const terminal = adaptTerminalCallToolResult(result);
    const rendered = renderTerminalCallToolResult(terminal);
    const toolCli = toToolCliCallToolResult(terminal);

    expect(terminal.result).toBe(result);
    expect(rendered.details).toBe(result);
    expect(rendered.content).toContainEqual({
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
    expect(rendered.content).toContainEqual({
      type: "text",
      text: "Structured content:\nfalse",
    });
    expect(
      rendered.content.some((block) => block.type === "text" && block.text.includes("audio/wav")),
    ).toBe(true);
    expect(
      rendered.content.some(
        (block) => block.type === "text" && block.text.includes("file:///guide.md"),
      ),
    ).toBe(true);
    expect(
      rendered.content.some(
        (block) => block.type === "text" && block.text.includes("embedded text"),
      ),
    ).toBe(true);
    expect(toolCli.structuredContent).toBe(false);
    expect(toolCli.content).toBe(result.content);
    expect(toolCli.isError).toBe(true);
  });

  it.each([null, 0, "", [], { nested: ["value"] }])(
    "retains arbitrary JSON structuredContent: %j",
    (structuredContent) => {
      const result: CallToolResult = { content: [], structuredContent };
      const rendered = renderTerminalCallToolResult(adaptTerminalCallToolResult(result));

      expect(rendered.details.structuredContent).toEqual(structuredContent);
      expect(rendered.content[0]).toEqual({
        type: "text",
        text: `Structured content:\n${JSON.stringify(structuredContent, null, 2)}`,
      });
    },
  );
});
