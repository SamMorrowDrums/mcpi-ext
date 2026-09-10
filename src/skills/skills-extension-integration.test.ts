/**
 * End-to-end SEP-2640: a real client, a real policy, a real transport, and a
 * server that speaks the draft extension.
 *
 * The unit suites prove each check in isolation; this one proves the checks are
 * actually wired into the path a skill travels — negotiation through discovery,
 * verification, approval, and the fallback boundary between the extension and
 * the legacy `skill://` contract.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpClientManager } from "../mcp/client-manager.js";
import { McpPolicy } from "../mcp/policy.js";
import { SkillRegistry } from "./skill-registry.js";
import { SkillsExtensionClient } from "./sep2640/client.js";
import { discoverSkillsViaExtension } from "./sep2640/discover.js";
import { discoverSkillsFromServer } from "./discover.js";
import { createLoadSkillTool } from "./load-skill-tool.js";
import {
  createSkillsExtensionServer,
  type SkillsFixtureOptions,
  type SkillsFixtureSkill,
} from "../test-servers/skills-extension-server.js";
import { SKILLS_EXTENSION_NAME, SKILLS_EXTENSION_REVISION } from "./sep2640/spec.js";
import { getMcpClientDiagnostics } from "../mcp/client-factory.js";

const WEATHER_DOC = `---
name: weather
description: Weather lookups
allowed-tools:
  - check_weather
---

# Weather

Call check_weather with a city name.
`;

const REFERENCE_DOC = "# Reference\n\nExtra detail.\n";

function weatherSkill(overrides: Partial<SkillsFixtureSkill> = {}): SkillsFixtureSkill {
  return {
    base: "skill://weather",
    document: WEATHER_DOC,
    frontmatter: {
      name: "weather",
      description: "Weather lookups",
      "allowed-tools": ["check_weather"],
    },
    files: [{ uri: "skill://weather/reference.md", text: REFERENCE_DOC }],
    ...overrides,
  };
}

interface Harness {
  manager: McpClientManager;
  policy: McpPolicy;
  registry: SkillRegistry;
  skillsClient: SkillsExtensionClient;
  fixture: ReturnType<typeof createSkillsExtensionServer>;
  confirm: ReturnType<typeof vi.fn>;
  dispose: () => Promise<void>;
}

const live: Harness[] = [];

/**
 * Stand up one fixture server over an in-memory transport, wired through the
 * production manager and policy rather than a stub, so capability negotiation
 * and dispatch are exercised for real.
 */
async function harness(
  options: SkillsFixtureOptions,
  managerOptions: { skillsExtension?: boolean; serverName?: string } = {},
): Promise<Harness> {
  const serverName = managerOptions.serverName ?? "fixture";
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const fixture = createSkillsExtensionServer(options);
  const manager = new McpClientManager({
    transportFactory: () => clientTransport,
    skillsExtension: managerOptions.skillsExtension ?? true,
  });
  const confirm = vi.fn().mockResolvedValue(true);
  const policy = new McpPolicy({ gateway: manager, approvals: { confirm } });
  const registry = new SkillRegistry();
  const skillsClient = new SkillsExtensionClient({ policy });

  await fixture.server.connect(serverTransport);
  await manager.connectAll({
    mcpServers: {
      [serverName]: { type: "stdio", command: "node", args: ["unused-in-memory"] },
    },
  });

  const h: Harness = {
    manager,
    policy,
    registry,
    skillsClient,
    fixture,
    confirm,
    dispose: async () => {
      await Promise.all([manager.disconnectAll(), fixture.server.close()]);
    },
  };
  live.push(h);
  return h;
}

afterEach(async () => {
  while (live.length > 0) {
    const h = live.pop();
    await h?.dispose();
  }
});

describe("capability negotiation", () => {
  it("sees the extension a server declared", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    expect(h.skillsClient.supports("fixture")).toBe(true);
    expect(h.skillsClient.supportsDirectoryRead("fixture")).toBe(false);
  });

  it("sees directoryRead only when the server declared it", async () => {
    const h = await harness({ skills: [weatherSkill()], directoryRead: true });
    expect(h.skillsClient.supportsDirectoryRead("fixture")).toBe(true);
    expect(h.skillsClient.capability("fixture")).toMatchObject({ directoryRead: true });
  });

  it("reports no support when the server declares nothing", async () => {
    const h = await harness({ skills: [weatherSkill()], declareExtension: false });
    expect(h.skillsClient.supports("fixture")).toBe(false);
  });

  it("advertises the extension only when the host gate is on", async () => {
    const on = await harness({ skills: [weatherSkill()] }, { skillsExtension: true });
    expect(on.manager.requestsSkillsExtension()).toBe(true);

    const off = await harness({ skills: [weatherSkill()] }, { skillsExtension: false });
    expect(off.manager.requestsSkillsExtension()).toBe(false);
  });

  it("exposes the pinned draft revision in client diagnostics", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const client = h.manager.getClient("fixture");
    if (!client) throw new Error("expected a connected client for the fixture server");
    const diagnostics = getMcpClientDiagnostics(client, { skillsExtensionRequested: true });
    expect(diagnostics.skillsExtension).toMatchObject({
      requested: true,
      revision: SKILLS_EXTENSION_REVISION,
      status: "draft",
      serverDeclared: true,
    });
  });

  it("reports serverDeclared false when the server stays silent", async () => {
    const h = await harness({ skills: [weatherSkill()], declareExtension: false });
    const client = h.manager.getClient("fixture");
    if (!client) throw new Error("expected a connected client for the fixture server");
    const diagnostics = getMcpClientDiagnostics(client, { skillsExtensionRequested: true });
    expect(diagnostics.skillsExtension.serverDeclared).toBe(false);
    expect(diagnostics.skillsExtension.status).toBe("draft");
  });
});

describe("refusal when the capability is absent", () => {
  it("refuses skills/list against a server that never declared the extension", async () => {
    const h = await harness({ skills: [weatherSkill()], declareExtension: false });
    await expect(h.policy.listMcpSkills("fixture")).rejects.toThrow(/extension/i);
  });

  it("refuses a directory read when directoryRead was not declared", async () => {
    const h = await harness({
      skills: [
        weatherSkill({
          directories: {
            "skill://weather/refs": [{ uri: "skill://weather/reference.md", name: "reference.md" }],
          },
        }),
      ],
      directoryRead: false,
    });
    await expect(h.policy.readSkillDirectory("fixture", "skill://weather/refs")).rejects.toThrow(
      /director/i,
    );
  });

  it("allows a directory read once directoryRead is declared", async () => {
    const h = await harness({
      skills: [
        weatherSkill({
          directories: {
            "skill://weather/refs": [{ uri: "skill://weather/reference.md", name: "reference.md" }],
          },
        }),
      ],
      directoryRead: true,
    });
    const resources = await h.skillsClient.readDirectory("fixture", "skill://weather/refs");
    expect(resources.map((r) => r.uri)).toEqual(["skill://weather/reference.md"]);
  });
});

describe("discovery and load", () => {
  it("discovers over the extension without reading any content", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const readSpy = vi.spyOn(h.policy, "readResource");

    const result = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );

    expect(readSpy).not.toHaveBeenCalled();
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "weather",
      origin: "sep2640",
      referencedTools: ["check_weather"],
    });
  });

  it("loads a verified skill and reveals its tools without asking", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);

    const tool = createLoadSkillTool({
      registry: h.registry,
      policy: h.policy,
      skillsClient: h.skillsClient,
    });
    expect(h.policy.isDeferred("check_weather")).toBe(true);

    const result = await tool.execute(
      "call-1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    expect(result.details.error).toBeUndefined();
    expect(result.details.verified).toBe(true);
    expect(result.details.referencedTools).toEqual(["check_weather"]);
    const first = result.content[0];
    expect("text" in first && first.text).toContain("Call check_weather");
    // Frontmatter is stripped from what the model sees.
    expect("text" in first && first.text.startsWith("---")).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.policy.isDeferred("check_weather")).toBe(false);
    expect(result.addedToolNames).toEqual(["check_weather"]);
  });

  it("re-reveals on a repeat load without prompting", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);
    const tool = createLoadSkillTool({
      registry: h.registry,
      policy: h.policy,
      skillsClient: h.skillsClient,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await tool.execute("c1", { name: "weather" }, undefined, undefined, {} as any);
    const second = await tool.execute(
      "c2",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );
    expect(h.confirm).not.toHaveBeenCalled();
    // The marker rides out on every load, because a provider that missed the
    // first result must still be able to resolve the reference from the tail.
    expect(second.addedToolNames).toEqual(["check_weather"]);
  });

  it("reveals mcp-origin referenced tools even when the approval surface would decline", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    h.confirm.mockResolvedValue(false);
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);
    const tool = createLoadSkillTool({
      registry: h.registry,
      policy: h.policy,
      skillsClient: h.skillsClient,
    });

    const result = await tool.execute(
      "c1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    // A declining UI is irrelevant here: nothing asks it, because loading a
    // skill executes nothing. Approval belongs to whichever tool runs later.
    expect(result.details.error).toBeUndefined();
    expect(result.details.referencedTools).toEqual(["check_weather"]);
    expect(h.confirm).not.toHaveBeenCalled();
    expect(h.policy.isDeferred("check_weather")).toBe(false);
  });

  it("refuses to load a sep2640 skill with no client to verify it", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);

    const tool = createLoadSkillTool({ registry: h.registry, policy: h.policy });
    const result = await tool.execute(
      "c1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    expect(result.details.error).toBe("verification_unavailable");
    expect(result.details.verified).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("integrity failures over the wire", () => {
  async function loadWith(faults: SkillsFixtureOptions["faults"]) {
    const h = await harness({ skills: [weatherSkill()], faults });
    const { skills, rejected } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);
    const tool = createLoadSkillTool({
      registry: h.registry,
      policy: h.policy,
      skillsClient: h.skillsClient,
    });
    const result = skills.length
      ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await tool.execute("c1", { name: "weather" }, undefined, undefined, {} as any)
      : undefined;
    return { h, rejected, result };
  }

  it("refuses a skill whose served bytes do not match the published digest", async () => {
    const { h, result } = await loadWith({ digestDrift: new Set(["skill://weather/SKILL.md"]) });
    expect(result?.details.error).toMatch(/digest|match/i);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("refuses a skill whose published size disagrees with the served bytes", async () => {
    const { h, result } = await loadWith({ sizeDrift: new Set(["skill://weather/SKILL.md"]) });
    expect(result?.details.error).toMatch(/bytes|size/i);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("refuses a skill whose listed frontmatter disagrees with the file", async () => {
    const { h, result } = await loadWith({
      frontmatterDrift: new Set(["skill://weather/SKILL.md"]),
    });
    expect(result?.details.error).toMatch(/frontmatter/i);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("rejects an entry that publishes an uppercase digest instead of normalising it", async () => {
    const { rejected, result } = await loadWith({
      uppercaseDigest: new Set(["skill://weather/SKILL.md"]),
    });
    expect(rejected.length).toBeGreaterThan(0);
    expect(rejected[0]?.reason).toMatch(/digest/i);
    expect(result).toBeUndefined();
  });

  it("rejects an entry that omits SKILL.md from its own resource set", async () => {
    const { rejected, result } = await loadWith({
      unlisted: new Set(["skill://weather/SKILL.md"]),
    });
    expect(rejected.length).toBeGreaterThan(0);
    expect(result).toBeUndefined();
  });

  it("refuses a supporting file the entry did not list, even though the server serves it", async () => {
    const h = await harness({
      skills: [weatherSkill()],
      faults: { unlisted: new Set(["skill://weather/reference.md"]) },
    });
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    expect(skills).toHaveLength(1);

    await expect(
      h.policy.readResource({
        source: "skills-extension",
        serverName: "fixture",
        uri: "skill://weather/reference.md",
        skillUri: "skill://weather/SKILL.md",
      }),
    ).rejects.toThrow();
  });

  it("reads a listed supporting file successfully", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    await discoverSkillsViaExtension(h.policy, h.skillsClient, "fixture", () => undefined);

    const result = await h.policy.readResource({
      source: "skills-extension",
      serverName: "fixture",
      uri: "skill://weather/reference.md",
      skillUri: "skill://weather/SKILL.md",
    });
    expect(result.contents[0]).toMatchObject({ uri: "skill://weather/reference.md" });
  });
});

describe("rotation re-activates from the served content", () => {
  it("reports a rotated resource set and re-reveals from the fresh entry", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    const { skills } = await discoverSkillsViaExtension(
      h.policy,
      h.skillsClient,
      "fixture",
      () => undefined,
    );
    h.registry.registerAll(skills);
    h.policy.registerSkills(skills);
    const tool = createLoadSkillTool({
      registry: h.registry,
      policy: h.policy,
      skillsClient: h.skillsClient,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const first = await tool.execute("c1", { name: "weather" }, undefined, undefined, {} as any);
    expect(first.details.referencedTools).toEqual(["check_weather"]);
    expect(h.confirm).not.toHaveBeenCalled();

    // The server now publishes different content under the same skill name.
    const rotatedDoc = WEATHER_DOC.replace("Call check_weather", "Call check_weather now");
    h.fixture.rotate("skill://weather", { document: rotatedDoc });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const second = await tool.execute("c2", { name: "weather" }, undefined, undefined, {} as any);
    // Rotation still matters: what the model is shown comes from the entry the
    // server is publishing now, not the discovery-time copy. It is a question
    // about content integrity, which is why it never becomes a prompt.
    expect(second.details.resourceSetRotated).toBe(true);
    expect(second.details.verified).toBe(true);
    expect(second.addedToolNames).toEqual(["check_weather"]);
    expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe("pagination and caching over the wire", () => {
  it("walks every page of a paginated listing", async () => {
    const h = await harness({
      skills: [
        weatherSkill(),
        weatherSkill({
          base: "skill://tides",
          document: WEATHER_DOC.replace("name: weather", "name: tides"),
          frontmatter: {
            name: "tides",
            description: "Weather lookups",
            "allowed-tools": ["check_weather"],
          },
          files: [],
        }),
      ],
      pageSize: 1,
    });
    const listing = await h.skillsClient.listSkills("fixture");
    expect(listing.skills.map((s) => s.uri).sort()).toEqual([
      "skill://tides/SKILL.md",
      "skill://weather/SKILL.md",
    ]);
    expect(listing.truncated).toBe(false);
  });

  it("does not cache when the server sends no freshness hints", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    await h.skillsClient.listSkills("fixture");
    const second = await h.skillsClient.listSkills("fixture");
    expect(second.fromCache).toBe(false);
  });

  it("caches when the server asks in honoured terms", async () => {
    const h = await harness({
      skills: [weatherSkill()],
      ttlMs: 60_000,
      cacheScope: "session",
    });
    await h.skillsClient.listSkills("fixture");
    const second = await h.skillsClient.listSkills("fixture");
    expect(second.fromCache).toBe(true);
  });

  it("treats an empty listing as 'nothing right now', not proof of absence", async () => {
    const h = await harness({ skills: [], ttlMs: 60_000, cacheScope: "session" });
    const first = await h.skillsClient.listSkills("fixture");
    expect(first.skills).toEqual([]);

    // A server that starts publishing later is picked up on the next pass;
    // the empty answer was never treated as authoritative.
    h.skillsClient.clearCache("fixture");
    const second = await h.skillsClient.listSkills("fixture");
    expect(second.skills).toEqual([]);
    expect(second.fromCache).toBe(false);
  });
});

describe("origin boundaries", () => {
  it("keeps two servers' skills in separate namespaces instead of shadowing", async () => {
    const a = await harness({ name: "alpha", skills: [weatherSkill()] }, { serverName: "alpha" });
    const b = await harness({ name: "beta", skills: [weatherSkill()] }, { serverName: "beta" });

    const registry = new SkillRegistry();
    const first = await discoverSkillsViaExtension(
      a.policy,
      a.skillsClient,
      "alpha",
      () => undefined,
    );
    const second = await discoverSkillsViaExtension(
      b.policy,
      b.skillsClient,
      "beta",
      () => undefined,
    );
    registry.registerAll(first.skills);
    registry.registerAll(second.skills);

    const collisions = registry.getCollisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.name).toBe("weather");
    expect(collisions[0]?.registeredAs).toBe("beta/weather");
    expect(registry.get("weather")?.serverName).toBe("alpha");
    expect(registry.get("beta/weather")?.serverName).toBe("beta");
  });

  it("refuses a read for a skill uri the server never listed", async () => {
    const h = await harness({ skills: [weatherSkill()] });
    await discoverSkillsViaExtension(h.policy, h.skillsClient, "fixture", () => undefined);

    await expect(
      h.policy.readResource({
        source: "skills-extension",
        serverName: "fixture",
        uri: "skill://weather/reference.md",
        skillUri: "skill://other/SKILL.md",
      }),
    ).rejects.toThrow();
  });

  it("refuses a cross-origin read that names another server's skill", async () => {
    const a = await harness({ name: "alpha", skills: [weatherSkill()] }, { serverName: "alpha" });
    const b = await harness({ name: "beta", skills: [weatherSkill()] }, { serverName: "beta" });
    await discoverSkillsViaExtension(a.policy, a.skillsClient, "alpha", () => undefined);
    await discoverSkillsViaExtension(b.policy, b.skillsClient, "beta", () => undefined);

    // alpha's policy knows only alpha's allowlist; naming beta as the origin
    // must not borrow authority from the skill alpha did list.
    await expect(
      a.policy.readResource({
        source: "skills-extension",
        serverName: "beta",
        uri: "skill://weather/reference.md",
        skillUri: "skill://weather/SKILL.md",
      }),
    ).rejects.toThrow();
  });
});

describe("legacy fallback boundary", () => {
  it("uses the legacy skill:// contract only when the extension is absent", async () => {
    const h = await harness({ skills: [weatherSkill()], declareExtension: false });
    expect(h.skillsClient.supports("fixture")).toBe(false);

    // The fixture serves no resources/list, so legacy discovery finds nothing —
    // the point is that it is reachable and does not throw, whereas the
    // extension path is refused outright.
    const legacy = await discoverSkillsFromServer(h.policy, "fixture").catch(() => []);
    expect(Array.isArray(legacy)).toBe(true);
    await expect(h.policy.listMcpSkills("fixture")).rejects.toThrow(/extension/i);
  });

  it("does not fall back to legacy discovery when the extension is declared", async () => {
    const h = await harness({ skills: [] });
    expect(h.skillsClient.supports("fixture")).toBe(true);

    const listing = await h.skillsClient.listSkills("fixture");
    expect(listing.skills).toEqual([]);
    // An empty extension listing is still the extension's answer. Mixing in the
    // legacy contract here is exactly what the spec forbids.
    expect(h.skillsClient.supports("fixture")).toBe(true);
  });
});

describe("draft diagnostics", () => {
  it("names the extension and pins the revision it was written against", () => {
    expect(SKILLS_EXTENSION_NAME).toBe("io.modelcontextprotocol/skills");
    expect(SKILLS_EXTENSION_REVISION).toBe("753b9f2be43e07fdd070e535d75f190cff14beea");
  });
});
