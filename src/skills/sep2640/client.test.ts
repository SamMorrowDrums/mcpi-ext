/**
 * SkillsExtensionClient: negotiation, pagination bounds, and cache discipline.
 *
 * The policy is faked here so the interesting axes — how many pages the client
 * is willing to walk, what it is willing to cache, and what it refuses to
 * conclude from an empty answer — can be exercised without a transport. The
 * live-transport behaviour is covered by skills-extension-integration.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { SkillsExtensionClient } from "./client.js";
import { MAX_CACHE_TTL_MS, MAX_SKILL_LIST_PAGES } from "./spec.js";
import type { McpPolicy } from "../../mcp/policy.js";
import type { SkillEntry } from "./protocol.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function entry(name: string): SkillEntry {
  return {
    uri: `skill://${name}/SKILL.md`,
    frontmatter: { name, description: `${name} skill` },
    resources: [{ uri: `skill://${name}/SKILL.md`, digest: DIGEST, size: 10 }],
  } as SkillEntry;
}

interface FakePolicyOptions {
  capability?: Record<string, unknown>;
  pages?: { skills: SkillEntry[]; nextCursor?: string; ttlMs?: number; cacheScope?: string }[];
  directoryPages?: { resources: { uri: string; name: string }[]; nextCursor?: string }[];
}

function fakePolicy(options: FakePolicyOptions = {}) {
  const pages = options.pages ?? [{ skills: [] }];
  const listMcpSkills = vi.fn((_server: string, cursor?: string) => {
    const index = cursor ? Number(cursor) : 0;
    return Promise.resolve(pages[Math.min(index, pages.length - 1)]);
  });
  const readSkillDirectory = vi.fn((_s: string, _u: string, cursor?: string) => {
    const dirs = options.directoryPages ?? [{ resources: [] }];
    const index = cursor ? Number(cursor) : 0;
    return Promise.resolve(dirs[Math.min(index, dirs.length - 1)]);
  });
  const getMcpSkill = vi.fn((_server: string, uri: string) =>
    Promise.resolve({ skill: entry(uri.split("/")[2] ?? "x") }),
  );

  const policy = {
    getSkillsExtension: () => options.capability,
    supportsSkillDirectoryRead: () => options.capability?.["directoryRead"] === true,
    listMcpSkills,
    getMcpSkill,
    readSkillDirectory,
  } as unknown as McpPolicy;

  return { policy, listMcpSkills, getMcpSkill, readSkillDirectory };
}

describe("negotiation", () => {
  it("reports no support when the server declared nothing", () => {
    const { policy } = fakePolicy();
    const client = new SkillsExtensionClient({ policy });
    expect(client.supports("srv")).toBe(false);
    expect(client.supportsDirectoryRead("srv")).toBe(false);
    expect(client.capability("srv")).toBeUndefined();
  });

  it("reports support for an empty settings object", () => {
    const { policy } = fakePolicy({ capability: {} });
    const client = new SkillsExtensionClient({ policy });
    expect(client.supports("srv")).toBe(true);
    expect(client.supportsDirectoryRead("srv")).toBe(false);
  });

  it("reports directory support only when explicitly declared", () => {
    const yes = new SkillsExtensionClient({
      policy: fakePolicy({ capability: { directoryRead: true } }).policy,
    });
    const no = new SkillsExtensionClient({
      policy: fakePolicy({ capability: { directoryRead: false } }).policy,
    });
    expect(yes.supportsDirectoryRead("srv")).toBe(true);
    expect(no.supportsDirectoryRead("srv")).toBe(false);
  });

  it("re-resolves support on every call rather than caching it", () => {
    let declared: Record<string, unknown> | undefined;
    const policy = {
      getSkillsExtension: () => declared,
      supportsSkillDirectoryRead: () => false,
    } as unknown as McpPolicy;
    const client = new SkillsExtensionClient({ policy });

    expect(client.supports("srv")).toBe(false);
    declared = {};
    expect(client.supports("srv")).toBe(true);
    declared = undefined;
    expect(client.supports("srv")).toBe(false);
  });
});

describe("listSkills", () => {
  it("returns validated entries", async () => {
    const { policy } = fakePolicy({ capability: {}, pages: [{ skills: [entry("weather")] }] });
    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.skills.map((s) => s.uri)).toEqual(["skill://weather/SKILL.md"]);
    expect(listing.rejected).toEqual([]);
    expect(listing.truncated).toBe(false);
  });

  it("surfaces invalid entries as rejected instead of silently dropping them", async () => {
    const bad = { ...entry("weather"), frontmatter: { name: "mismatch", description: "d" } };
    const { policy } = fakePolicy({
      capability: {},
      pages: [{ skills: [entry("alpha"), bad as SkillEntry] }],
    });
    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.skills.map((s) => s.uri)).toEqual(["skill://alpha/SKILL.md"]);
    expect(listing.rejected).toHaveLength(1);
    expect(listing.rejected[0]?.uri).toBe("skill://weather/SKILL.md");
  });

  it("follows cursors across pages", async () => {
    const { policy, listMcpSkills } = fakePolicy({
      capability: {},
      pages: [
        { skills: [entry("a")], nextCursor: "1" },
        { skills: [entry("b")], nextCursor: "2" },
        { skills: [entry("c")] },
      ],
    });
    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.skills).toHaveLength(3);
    expect(listing.truncated).toBe(false);
    expect(listMcpSkills).toHaveBeenCalledTimes(3);
  });

  it("stops and marks truncated when a server repeats a cursor", async () => {
    const listMcpSkills = vi.fn(() =>
      Promise.resolve({ skills: [entry("loop")], nextCursor: "same" }),
    );
    const policy = {
      getSkillsExtension: () => ({}),
      supportsSkillDirectoryRead: () => false,
      listMcpSkills,
    } as unknown as McpPolicy;

    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.truncated).toBe(true);
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("stops at the page ceiling and marks the result truncated", async () => {
    let page = 0;
    const listMcpSkills = vi.fn(() => {
      page += 1;
      return Promise.resolve({ skills: [entry(`s${String(page)}`)], nextCursor: String(page) });
    });
    const policy = {
      getSkillsExtension: () => ({}),
      supportsSkillDirectoryRead: () => false,
      listMcpSkills,
    } as unknown as McpPolicy;

    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.truncated).toBe(true);
    expect(listMcpSkills).toHaveBeenCalledTimes(MAX_SKILL_LIST_PAGES);
  });

  it("returns an empty listing without implying the server has no skills", async () => {
    const { policy } = fakePolicy({ capability: {}, pages: [{ skills: [] }] });
    const listing = await new SkillsExtensionClient({ policy }).listSkills("srv");
    expect(listing.skills).toEqual([]);
    // The absence of skills is not cached and not marked authoritative, so a
    // later call re-asks the server rather than reusing "there are none".
    expect(listing.fromCache).toBe(false);
  });
});

describe("cache discipline", () => {
  const cacheable = (extra: Record<string, unknown>) => ({
    capability: {},
    pages: [{ skills: [entry("weather")], ...extra }],
  });

  it("does not cache when the server sent no freshness hints", async () => {
    const { policy, listMcpSkills } = fakePolicy(cacheable({}));
    const client = new SkillsExtensionClient({ policy });
    await client.listSkills("srv");
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(false);
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("does not cache when ttlMs is present but cacheScope is absent", async () => {
    const { policy, listMcpSkills } = fakePolicy(cacheable({ ttlMs: 60_000 }));
    const client = new SkillsExtensionClient({ policy });
    await client.listSkills("srv");
    await client.listSkills("srv");
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("does not cache an unrecognised cacheScope rather than guessing its meaning", async () => {
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: 60_000, cacheScope: "global" }),
    );
    const client = new SkillsExtensionClient({ policy });
    await client.listSkills("srv");
    await client.listSkills("srv");
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("does not cache a non-positive ttl", async () => {
    const { policy, listMcpSkills } = fakePolicy(cacheable({ ttlMs: 0, cacheScope: "session" }));
    const client = new SkillsExtensionClient({ policy });
    await client.listSkills("srv");
    await client.listSkills("srv");
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("caches within the ttl when the server asked in honoured terms", async () => {
    let clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: 60_000, cacheScope: "session" }),
    );
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    clock += 59_000;
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(true);
    expect(listMcpSkills).toHaveBeenCalledTimes(1);
  });

  it("re-fetches once the ttl expires", async () => {
    let clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: 60_000, cacheScope: "session" }),
    );
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    clock += 60_001;
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(false);
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("clamps an over-long ttl to the host ceiling", async () => {
    let clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: MAX_CACHE_TTL_MS * 100, cacheScope: "session" }),
    );
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    clock += MAX_CACHE_TTL_MS + 1;
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(false);
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("never caches a truncated listing", async () => {
    const listMcpSkills = vi.fn(() =>
      Promise.resolve({
        skills: [entry("loop")],
        nextCursor: "same",
        ttlMs: 60_000,
        cacheScope: "session",
      }),
    );
    const policy = {
      getSkillsExtension: () => ({}),
      supportsSkillDirectoryRead: () => false,
      listMcpSkills,
    } as unknown as McpPolicy;
    const client = new SkillsExtensionClient({ policy });

    const first = await client.listSkills("srv");
    expect(first.truncated).toBe(true);
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(false);
  });

  it("only honours freshness hints from the first page", async () => {
    let clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy({
      capability: {},
      pages: [
        { skills: [entry("a")], nextCursor: "1" },
        { skills: [entry("b")], ttlMs: 60_000, cacheScope: "session" },
      ],
    });
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    clock += 1;
    const second = await client.listSkills("srv");
    expect(second.fromCache).toBe(false);
    expect(listMcpSkills.mock.calls.length).toBeGreaterThan(2);
  });

  it("clears a cached listing on request", async () => {
    const clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: 60_000, cacheScope: "session" }),
    );
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    client.clearCache("srv");
    await client.listSkills("srv");
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });

  it("scopes the cache per server", async () => {
    const clock = 1_000;
    const { policy, listMcpSkills } = fakePolicy(
      cacheable({ ttlMs: 60_000, cacheScope: "session" }),
    );
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("alpha");
    const other = await client.listSkills("beta");
    expect(other.fromCache).toBe(false);
    expect(listMcpSkills).toHaveBeenCalledTimes(2);
  });
});

describe("getSkill", () => {
  it("always goes to the server, so recovery is never served from cache", async () => {
    const clock = 1_000;
    const { policy, getMcpSkill } = fakePolicy({
      capability: {},
      pages: [{ skills: [entry("weather")], ttlMs: 60_000, cacheScope: "session" }],
    });
    const client = new SkillsExtensionClient({ policy, now: () => clock });

    await client.listSkills("srv");
    await client.getSkill("srv", "skill://weather/SKILL.md");
    await client.getSkill("srv", "skill://weather/SKILL.md");
    expect(getMcpSkill).toHaveBeenCalledTimes(2);
  });

  it("validates the returned entry", async () => {
    const getMcpSkill = vi.fn(() =>
      Promise.resolve({
        skill: { ...entry("weather"), frontmatter: { name: "other", description: "d" } },
      }),
    );
    const policy = {
      getSkillsExtension: () => ({}),
      supportsSkillDirectoryRead: () => false,
      getMcpSkill,
    } as unknown as McpPolicy;

    await expect(
      new SkillsExtensionClient({ policy }).getSkill("srv", "skill://weather/SKILL.md"),
    ).rejects.toThrow(/name/i);
  });
});

describe("readDirectory", () => {
  it("paginates directory listings", async () => {
    const { policy } = fakePolicy({
      capability: { directoryRead: true },
      directoryPages: [
        { resources: [{ uri: "skill://a/one.md", name: "one.md" }], nextCursor: "1" },
        { resources: [{ uri: "skill://a/two.md", name: "two.md" }] },
      ],
    });
    const resources = await new SkillsExtensionClient({ policy }).readDirectory("srv", "skill://a");
    expect(resources.map((r) => r.uri)).toEqual(["skill://a/one.md", "skill://a/two.md"]);
  });

  it("stops on a repeated cursor", async () => {
    const readSkillDirectory = vi.fn(() =>
      Promise.resolve({ resources: [{ uri: "skill://a/x", name: "x" }], nextCursor: "same" }),
    );
    const policy = {
      getSkillsExtension: () => ({ directoryRead: true }),
      supportsSkillDirectoryRead: () => true,
      readSkillDirectory,
    } as unknown as McpPolicy;

    await new SkillsExtensionClient({ policy }).readDirectory("srv", "skill://a");
    expect(readSkillDirectory).toHaveBeenCalledTimes(2);
  });
});
