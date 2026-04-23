import { describe, it, expect } from "vitest";
import { SkillRegistry, type McpSkillMetadata } from "./skill-registry.js";

function makeSkill(overrides: Partial<McpSkillMetadata> = {}): McpSkillMetadata {
  return {
    name: "test-skill",
    description: "A test skill",
    uri: "skill://test/SKILL.md",
    serverName: "test-server",
    allowedTools: ["tool_a"],
    ...overrides,
  };
}

describe("SkillRegistry", () => {
  it("registers and retrieves a skill", () => {
    const reg = new SkillRegistry();
    const skill = makeSkill();
    reg.register(skill);

    expect(reg.get("test-skill")).toEqual(skill);
    expect(reg.size).toBe(1);
  });

  it("getAll returns all registered skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "a" }));
    reg.register(makeSkill({ name: "b" }));

    expect(reg.getAll()).toHaveLength(2);
  });

  it("overwrites on duplicate name", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ description: "first" }));
    reg.register(makeSkill({ description: "second" }));

    expect(reg.size).toBe(1);
    expect(reg.get("test-skill")?.description).toBe("second");
  });

  it("unregister removes by name", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill());

    expect(reg.unregister("test-skill")).toBe(true);
    expect(reg.get("test-skill")).toBeUndefined();
    expect(reg.unregister("test-skill")).toBe(false);
  });

  it("unregisterByServer removes all skills from a server", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "a", serverName: "srv1" }));
    reg.register(makeSkill({ name: "b", serverName: "srv1" }));
    reg.register(makeSkill({ name: "c", serverName: "srv2" }));

    reg.unregisterByServer("srv1");

    expect(reg.size).toBe(1);
    expect(reg.get("c")).toBeDefined();
  });

  it("registerAll registers multiple skills", () => {
    const reg = new SkillRegistry();
    reg.registerAll([makeSkill({ name: "x" }), makeSkill({ name: "y" })]);

    expect(reg.size).toBe(2);
  });

  it("clear removes everything", () => {
    const reg = new SkillRegistry();
    reg.registerAll([makeSkill({ name: "a" }), makeSkill({ name: "b" })]);

    reg.clear();
    expect(reg.size).toBe(0);
    expect(reg.getAll()).toEqual([]);
  });

  it("get returns undefined for unknown name", () => {
    const reg = new SkillRegistry();
    expect(reg.get("nonexistent")).toBeUndefined();
  });
});
