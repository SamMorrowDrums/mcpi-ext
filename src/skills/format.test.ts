import { describe, it, expect } from "vitest";
import { formatMcpSkillsForPrompt } from "./format.js";
import type { McpSkillMetadata } from "./skill-registry.js";

describe("formatMcpSkillsForPrompt", () => {
  it("returns empty string for no skills", () => {
    expect(formatMcpSkillsForPrompt([])).toBe("");
  });

  it("formats a single skill", () => {
    const skills: McpSkillMetadata[] = [
      {
        name: "weather",
        description: "Check weather forecasts",
        uri: "skill://weather/SKILL.md",
        serverName: "weather-srv",
        allowedTools: ["check_weather"],
      },
    ];

    const result = formatMcpSkillsForPrompt(skills);
    expect(result).toContain("<available_mcp_skills>");
    expect(result).toContain("</available_mcp_skills>");
    expect(result).toContain("<name>weather</name>");
    expect(result).toContain("<description>Check weather forecasts</description>");
    expect(result).toContain("<server>weather-srv</server>");
    expect(result).toContain("load_skill");
  });

  it("formats multiple skills", () => {
    const skills: McpSkillMetadata[] = [
      {
        name: "a",
        description: "Skill A",
        uri: "skill://a/SKILL.md",
        serverName: "srv",
        allowedTools: [],
      },
      {
        name: "b",
        description: "Skill B",
        uri: "skill://b/SKILL.md",
        serverName: "srv",
        allowedTools: ["tool_b"],
      },
    ];

    const result = formatMcpSkillsForPrompt(skills);
    expect(result).toContain("<name>a</name>");
    expect(result).toContain("<name>b</name>");
  });

  it("escapes XML characters", () => {
    const skills: McpSkillMetadata[] = [
      {
        name: "test",
        description: 'Uses <tags> & "quotes"',
        uri: "skill://test/SKILL.md",
        serverName: "srv",
        allowedTools: [],
      },
    ];

    const result = formatMcpSkillsForPrompt(skills);
    expect(result).toContain("&lt;tags&gt;");
    expect(result).toContain("&amp;");
    expect(result).toContain("&quot;quotes&quot;");
  });
});
