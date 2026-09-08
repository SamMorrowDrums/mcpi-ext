import { describe, expect, it } from "vitest";
import { parseFrontmatter, stripFrontmatter } from "./frontmatter.js";

describe("frontmatter helpers", () => {
  it("parses nested YAML and strips the document body", () => {
    const parsed = parseFrontmatter(
      [
        "---",
        "name: weather",
        "allowed-tools:",
        "  - get_weather",
        "metadata:",
        "  io.modelcontextprotocol/tools: get_weather get_forecast",
        "---",
        "",
        "  Skill instructions.  ",
      ].join("\n"),
    );

    expect(parsed).toEqual({
      frontmatter: {
        name: "weather",
        "allowed-tools": ["get_weather"],
        metadata: {
          "io.modelcontextprotocol/tools": "get_weather get_forecast",
        },
      },
      body: "Skill instructions.",
    });
  });

  it("normalizes newlines without trimming documents that have no frontmatter", () => {
    expect(parseFrontmatter("  body\r\nnext\r")).toEqual({
      frontmatter: {},
      body: "  body\nnext\n",
    });
  });

  it("leaves an unterminated frontmatter marker in the body", () => {
    const content = "---\nname: weather\ninstructions";
    expect(parseFrontmatter(content)).toEqual({ frontmatter: {}, body: content });
  });

  it("uses the same parser for stripping frontmatter", () => {
    expect(stripFrontmatter("---\nname: weather\n---\n\nUse get_weather.\n")).toBe(
      "Use get_weather.",
    );
  });
});
