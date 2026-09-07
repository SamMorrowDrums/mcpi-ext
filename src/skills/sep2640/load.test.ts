/**
 * Discovery and load paths: what gets registered, what gets read, and when.
 *
 * The two properties worth defending here are that discovery reads nothing (the
 * spec forbids prefetching, and the listing already carries frontmatter), and
 * that no code path hands back content that has not been verified.
 */
import { describe, expect, it, vi } from "vitest";
import { discoverSkillsViaExtension } from "./discover.js";
import { SkillFetchBudget, loadSkillDocument, readSkillResource } from "./load.js";
import { computeDigest, textToBytes } from "./integrity.js";
import type { McpPolicy } from "../../mcp/policy.js";
import type { SkillsExtensionClient } from "./client.js";
import type { SkillEntry } from "./protocol.js";

const DOCUMENT = `---
name: weather
description: Weather lookups
allowed-tools:
  - check_weather
---

# Weather

Body.
`;

const DOC_BYTES = textToBytes(DOCUMENT);

function weatherEntry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    uri: "skill://weather/SKILL.md",
    frontmatter: {
      name: "weather",
      description: "Weather lookups",
      "allowed-tools": ["check_weather"],
    },
    resources: [
      {
        uri: "skill://weather/SKILL.md",
        digest: computeDigest(DOC_BYTES),
        size: DOC_BYTES.byteLength,
      },
    ],
    ...overrides,
  } as SkillEntry;
}

function fakeClient(listing: {
  skills: SkillEntry[];
  rejected?: { uri: string; reason: string }[];
  truncated?: boolean;
  fromCache?: boolean;
}) {
  const listSkills = vi.fn(() =>
    Promise.resolve({
      skills: listing.skills,
      rejected: listing.rejected ?? [],
      truncated: listing.truncated ?? false,
      fromCache: listing.fromCache ?? false,
    }),
  );
  return { client: { listSkills } as unknown as SkillsExtensionClient, listSkills };
}

function fakePolicy(readImpl?: (uri: string) => unknown) {
  const registerSkillResources = vi.fn();
  const readResource = vi.fn((request: { uri: string }) =>
    Promise.resolve(
      readImpl?.(request.uri) ?? {
        contents: [{ uri: request.uri, mimeType: "text/markdown", text: DOCUMENT }],
      },
    ),
  );
  const policy = { registerSkillResources, readResource } as unknown as McpPolicy;
  return { policy, registerSkillResources, readResource };
}

describe("discoverSkillsViaExtension", () => {
  it("builds metadata from the listing without reading anything", async () => {
    const { policy, readResource } = fakePolicy();
    const { client } = fakeClient({ skills: [weatherEntry()] });

    const result = await discoverSkillsViaExtension(policy, client, "srv", () => undefined);

    expect(readResource).not.toHaveBeenCalled();
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]).toMatchObject({
      name: "weather",
      description: "Weather lookups",
      uri: "skill://weather/SKILL.md",
      serverName: "srv",
      origin: "sep2640",
      allowedTools: ["check_weather"],
    });
    expect(result.skills[0]?.contentFingerprint).toBeTruthy();
  });

  it("registers exactly the listed resource uris as the read allowlist", async () => {
    const { policy, registerSkillResources } = fakePolicy();
    const entry = weatherEntry({
      resources: [
        {
          uri: "skill://weather/SKILL.md",
          digest: computeDigest(DOC_BYTES),
          size: DOC_BYTES.byteLength,
        },
        { uri: "skill://weather/ref.md", digest: `sha256:${"b".repeat(64)}`, size: 4 },
      ],
    });
    const { client } = fakeClient({ skills: [entry] });

    await discoverSkillsViaExtension(policy, client, "srv", () => undefined);

    expect(registerSkillResources).toHaveBeenCalledWith("srv", "skill://weather/SKILL.md", [
      "skill://weather/SKILL.md",
      "skill://weather/ref.md",
    ]);
  });

  it("registers no readable uris for a dynamic resource set", async () => {
    const { policy, registerSkillResources } = fakePolicy();
    const { client } = fakeClient({ skills: [weatherEntry({ resources: "dynamic" })] });

    await discoverSkillsViaExtension(policy, client, "srv", () => undefined);

    expect(registerSkillResources).toHaveBeenCalledWith("srv", "skill://weather/SKILL.md", []);
  });

  it("honours only the spec's allowed-tools key", async () => {
    const { policy } = fakePolicy();
    const entry = weatherEntry({
      frontmatter: {
        name: "weather",
        description: "d",
        "io.modelcontextprotocol/tools": ["sneaky_tool"],
      },
    });
    const { client } = fakeClient({ skills: [entry] });

    const result = await discoverSkillsViaExtension(policy, client, "srv", () => undefined);
    expect(result.skills[0]?.allowedTools).toEqual([]);
  });

  it("accepts a whitespace-separated allowed-tools string", async () => {
    const { policy } = fakePolicy();
    const entry = weatherEntry({
      frontmatter: { name: "weather", description: "d", "allowed-tools": "a b  c" },
    });
    const { client } = fakeClient({ skills: [entry] });

    const result = await discoverSkillsViaExtension(policy, client, "srv", () => undefined);
    expect(result.skills[0]?.allowedTools).toEqual(["a", "b", "c"]);
  });

  it("logs and carries forward rejections from the listing", async () => {
    const { policy } = fakePolicy();
    const { client } = fakeClient({
      skills: [],
      rejected: [{ uri: "skill://bad/SKILL.md", reason: "bad digest" }],
    });
    const log = vi.fn();

    const result = await discoverSkillsViaExtension(policy, client, "srv", log);

    expect(result.rejected).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("skill://bad/SKILL.md"));
  });

  it("surfaces truncation instead of presenting a partial view as complete", async () => {
    const { policy } = fakePolicy();
    const { client } = fakeClient({ skills: [weatherEntry()], truncated: true });
    const log = vi.fn();

    const result = await discoverSkillsViaExtension(policy, client, "srv", log);

    expect(result.truncated).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("truncated"));
  });

  it("returns an empty set without asserting the server has no skills", async () => {
    const { policy, registerSkillResources } = fakePolicy();
    const { client } = fakeClient({ skills: [] });

    const result = await discoverSkillsViaExtension(policy, client, "srv", () => undefined);

    expect(result.skills).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(registerSkillResources).not.toHaveBeenCalled();
  });
});

describe("readSkillResource", () => {
  it("returns verified bytes for a listed resource", async () => {
    const { policy } = fakePolicy();
    const resource = await readSkillResource({
      policy,
      entry: weatherEntry(),
      serverName: "srv",
      uri: "skill://weather/SKILL.md",
    });
    expect(resource.text).toBe(DOCUMENT);
  });

  it("passes the owning skill uri so the policy can scope the allowlist", async () => {
    const { policy, readResource } = fakePolicy();
    await readSkillResource({
      policy,
      entry: weatherEntry(),
      serverName: "srv",
      uri: "skill://weather/SKILL.md",
    });
    expect(readResource).toHaveBeenCalledWith(
      expect.objectContaining({ skillUri: "skill://weather/SKILL.md", serverName: "srv" }),
    );
  });

  it("refuses a resource the entry did not list", async () => {
    const { policy } = fakePolicy(() => ({
      contents: [{ uri: "skill://weather/secret.md", text: "secret" }],
    }));
    await expect(
      readSkillResource({
        policy,
        entry: weatherEntry(),
        serverName: "srv",
        uri: "skill://weather/secret.md",
      }),
    ).rejects.toThrow(/not listed/i);
  });

  it("refuses content of the right length whose digest differs", async () => {
    // Same byte count, different bytes: only the digest can catch this.
    const tampered = DOCUMENT.replace("Body.", "Bodyz");
    expect(textToBytes(tampered).byteLength).toBe(DOC_BYTES.byteLength);
    const { policy } = fakePolicy(() => ({
      contents: [{ uri: "skill://weather/SKILL.md", text: tampered }],
    }));

    await expect(
      readSkillResource({
        policy,
        entry: weatherEntry(),
        serverName: "srv",
        uri: "skill://weather/SKILL.md",
      }),
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("refuses content whose length differs from the declaration", async () => {
    const { policy } = fakePolicy(() => ({
      contents: [{ uri: "skill://weather/SKILL.md", text: `${DOCUMENT}extra` }],
    }));
    await expect(
      readSkillResource({
        policy,
        entry: weatherEntry(),
        serverName: "srv",
        uri: "skill://weather/SKILL.md",
      }),
    ).rejects.toMatchObject({ code: "size_mismatch" });
  });

  it("verifies base64 blob content the same way as text", async () => {
    const { policy } = fakePolicy(() => ({
      contents: [
        {
          uri: "skill://weather/SKILL.md",
          blob: Buffer.from(DOCUMENT, "utf8").toString("base64"),
        },
      ],
    }));
    const resource = await readSkillResource({
      policy,
      entry: weatherEntry(),
      serverName: "srv",
      uri: "skill://weather/SKILL.md",
    });
    expect(resource.text).toBe(DOCUMENT);
  });

  it("rejects a read that returned neither text nor blob", async () => {
    const { policy } = fakePolicy(() => ({
      contents: [{ uri: "skill://weather/SKILL.md" }],
    }));
    await expect(
      readSkillResource({
        policy,
        entry: weatherEntry(),
        serverName: "srv",
        uri: "skill://weather/SKILL.md",
      }),
    ).rejects.toThrow(/neither text nor blob/i);
  });

  it("rejects a read that returned no content at all", async () => {
    const { policy } = fakePolicy(() => ({ contents: [] }));
    await expect(
      readSkillResource({
        policy,
        entry: weatherEntry(),
        serverName: "srv",
        uri: "skill://weather/SKILL.md",
      }),
    ).rejects.toThrow(/no content/i);
  });

  it("advances the dynamic byte budget as content arrives", async () => {
    const { policy } = fakePolicy();
    const budget = new SkillFetchBudget();
    await readSkillResource({
      policy,
      entry: weatherEntry({ resources: "dynamic" }),
      serverName: "srv",
      uri: "skill://weather/anything.md",
      budget,
    });
    expect(budget.bytesRetrieved).toBe(DOC_BYTES.byteLength);
  });
});

describe("loadSkillDocument", () => {
  it("returns the full document, frontmatter included, so callers verify what was digested", async () => {
    const { policy } = fakePolicy();
    const resource = await loadSkillDocument({
      policy,
      entry: weatherEntry(),
      serverName: "srv",
    });
    expect(resource.text).toBe(DOCUMENT);
    expect(resource.text.startsWith("---")).toBe(true);
  });

  it("refuses when the served frontmatter disagrees with the listing", async () => {
    const { policy } = fakePolicy();
    const drifted = weatherEntry({
      frontmatter: {
        name: "weather",
        description: "something else entirely",
        "allowed-tools": ["check_weather"],
      },
      resources: [
        {
          uri: "skill://weather/SKILL.md",
          digest: computeDigest(DOC_BYTES),
          size: DOC_BYTES.byteLength,
        },
      ],
    });
    await expect(loadSkillDocument({ policy, entry: drifted, serverName: "srv" })).rejects.toThrow(
      /frontmatter/i,
    );
  });

  it("refuses when the name does not match the path, before reading", async () => {
    const { policy, readResource } = fakePolicy();
    const mismatched = weatherEntry({ uri: "skill://storm/SKILL.md" });
    await expect(
      loadSkillDocument({ policy, entry: mismatched, serverName: "srv" }),
    ).rejects.toThrow(/name/i);
    expect(readResource).not.toHaveBeenCalled();
  });
});
