/**
 * Pre-fetch validation of SEP-2640 listing entries.
 *
 * Every case here is decidable from the listing alone. That matters: the spec
 * requires the ceilings to be enforced *before* anything is retrieved, so a
 * hostile listing cannot make the host spend bandwidth to discover it is
 * hostile.
 */
import { describe, expect, it } from "vitest";
import { MAX_SKILL_RESOURCE_ENTRIES, MAX_SKILL_TOTAL_BYTES } from "./spec.js";
import {
  SkillValidationError,
  finalPathSegment,
  findResourceRef,
  isValidDigest,
  resourceSetFingerprint,
  skillPathOf,
  validateSkillEntry,
  type SkillEntry,
} from "./protocol.js";

const DIGEST = `sha256:${"a".repeat(64)}`;

function entry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    uri: "skill://weather/SKILL.md",
    frontmatter: { name: "weather", description: "Weather lookups" },
    resources: [{ uri: "skill://weather/SKILL.md", digest: DIGEST, size: 100 }],
    ...overrides,
  } as SkillEntry;
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SkillValidationError) return err.code;
    throw err;
  }
  return "no_error";
}

describe("isValidDigest", () => {
  it("accepts sha256 with 64 lowercase hex characters", () => {
    expect(isValidDigest(DIGEST)).toBe(true);
  });

  it("rejects uppercase hex rather than normalising it", () => {
    expect(isValidDigest(`sha256:${"A".repeat(64)}`)).toBe(false);
  });

  it("rejects other algorithms and wrong lengths", () => {
    expect(isValidDigest(`sha512:${"a".repeat(64)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(63)}`)).toBe(false);
    expect(isValidDigest(`sha256:${"a".repeat(65)}`)).toBe(false);
    expect(isValidDigest("a".repeat(64))).toBe(false);
  });
});

describe("skillPathOf / finalPathSegment", () => {
  it("strips the SKILL.md suffix to recover the skill path", () => {
    expect(skillPathOf("skill://weather/SKILL.md")).toBe("skill://weather");
    expect(skillPathOf("skill://github/pdf/SKILL.md")).toBe("skill://github/pdf");
  });

  it("returns undefined when the uri does not end in SKILL.md", () => {
    expect(skillPathOf("skill://weather/README.md")).toBeUndefined();
  });

  it("takes the last segment of the skill path as the name", () => {
    expect(finalPathSegment("skill://github/pdf")).toBe("pdf");
    expect(finalPathSegment("skill://weather")).toBe("weather");
  });
});

describe("validateSkillEntry", () => {
  it("accepts a conforming entry", () => {
    expect(() => validateSkillEntry(entry())).not.toThrow();
  });

  it("accepts a dynamic resource set", () => {
    expect(() => validateSkillEntry(entry({ resources: "dynamic" }))).not.toThrow();
  });

  it("rejects a malformed digest", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [{ uri: "skill://weather/SKILL.md", digest: "sha256:nope", size: 1 }],
          }),
        ),
      ),
    ).toBe("malformed_digest");
  });

  it("rejects an uppercase digest without normalising it", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [
              {
                uri: "skill://weather/SKILL.md",
                digest: `sha256:${"A".repeat(64)}`,
                size: 1,
              },
            ],
          }),
        ),
      ),
    ).toBe("malformed_digest");
  });

  it("rejects a duplicate resource uri", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [
              { uri: "skill://weather/SKILL.md", digest: DIGEST, size: 1 },
              { uri: "skill://weather/SKILL.md", digest: DIGEST, size: 2 },
            ],
          }),
        ),
      ),
    ).toBe("duplicate_resource_uri");
  });

  it("accepts exactly the maximum number of resources", () => {
    const resources = [{ uri: "skill://weather/SKILL.md", digest: DIGEST, size: 1 }];
    for (let i = 1; i < MAX_SKILL_RESOURCE_ENTRIES; i++) {
      resources.push({ uri: `skill://weather/file-${String(i)}.md`, digest: DIGEST, size: 1 });
    }
    expect(resources).toHaveLength(MAX_SKILL_RESOURCE_ENTRIES);
    expect(() => validateSkillEntry(entry({ resources }))).not.toThrow();
  });

  it("rejects one resource beyond the maximum", () => {
    const resources = [{ uri: "skill://weather/SKILL.md", digest: DIGEST, size: 1 }];
    for (let i = 1; i <= MAX_SKILL_RESOURCE_ENTRIES; i++) {
      resources.push({ uri: `skill://weather/file-${String(i)}.md`, digest: DIGEST, size: 1 });
    }
    expect(codeOf(() => validateSkillEntry(entry({ resources })))).toBe("resource_limit_exceeded");
  });

  it("accepts exactly the maximum declared byte count", () => {
    expect(() =>
      validateSkillEntry(
        entry({
          resources: [
            { uri: "skill://weather/SKILL.md", digest: DIGEST, size: MAX_SKILL_TOTAL_BYTES },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("rejects one byte beyond the maximum, before any fetch", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [
              {
                uri: "skill://weather/SKILL.md",
                digest: DIGEST,
                size: MAX_SKILL_TOTAL_BYTES + 1,
              },
            ],
          }),
        ),
      ),
    ).toBe("size_limit_exceeded");
  });

  it("sums sizes across resources when applying the byte ceiling", () => {
    const half = Math.floor(MAX_SKILL_TOTAL_BYTES / 2) + 1;
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [
              { uri: "skill://weather/SKILL.md", digest: DIGEST, size: half },
              { uri: "skill://weather/extra.md", digest: DIGEST, size: half },
            ],
          }),
        ),
      ),
    ).toBe("size_limit_exceeded");
  });

  it("rejects an entry whose own SKILL.md is not in its resource set", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            resources: [{ uri: "skill://weather/other.md", digest: DIGEST, size: 1 }],
          }),
        ),
      ),
    ).toBe("skill_md_not_listed");
  });

  it("rejects a missing frontmatter name", () => {
    expect(codeOf(() => validateSkillEntry(entry({ frontmatter: { description: "d" } })))).toBe(
      "missing_frontmatter_field",
    );
  });

  it("rejects a missing frontmatter description", () => {
    expect(codeOf(() => validateSkillEntry(entry({ frontmatter: { name: "weather" } })))).toBe(
      "missing_frontmatter_field",
    );
  });

  it("rejects a name that disagrees with the final path segment", () => {
    expect(
      codeOf(() => validateSkillEntry(entry({ frontmatter: { name: "storm", description: "d" } }))),
    ).toBe("name_path_mismatch");
  });

  it("rejects a uri that is not a SKILL.md", () => {
    expect(
      codeOf(() =>
        validateSkillEntry(
          entry({
            uri: "skill://weather/README.md",
            resources: [{ uri: "skill://weather/README.md", digest: DIGEST, size: 1 }],
          }),
        ),
      ),
    ).toBe("name_path_mismatch");
  });
});

describe("findResourceRef", () => {
  it("finds a listed resource", () => {
    const ref = findResourceRef(entry(), "skill://weather/SKILL.md");
    expect(ref).not.toBe("dynamic");
    expect(ref).toMatchObject({ size: 100 });
  });

  it("returns undefined for an unlisted resource", () => {
    expect(findResourceRef(entry(), "skill://weather/secret.md")).toBeUndefined();
  });

  it("reports the dynamic sentinel rather than a ref, since nothing is declared", () => {
    expect(findResourceRef(entry({ resources: "dynamic" }), "skill://weather/SKILL.md")).toBe(
      "dynamic",
    );
  });
});

describe("resourceSetFingerprint", () => {
  it("is stable for the same set", () => {
    expect(resourceSetFingerprint(entry())).toBe(resourceSetFingerprint(entry()));
  });

  it("changes when a digest rotates", () => {
    const rotated = entry({
      resources: [
        { uri: "skill://weather/SKILL.md", digest: `sha256:${"b".repeat(64)}`, size: 100 },
      ],
    });
    expect(resourceSetFingerprint(rotated)).not.toBe(resourceSetFingerprint(entry()));
  });

  it("changes when a resource is added", () => {
    const grown = entry({
      resources: [
        { uri: "skill://weather/SKILL.md", digest: DIGEST, size: 100 },
        { uri: "skill://weather/extra.md", digest: DIGEST, size: 1 },
      ],
    });
    expect(resourceSetFingerprint(grown)).not.toBe(resourceSetFingerprint(entry()));
  });

  it("is order-insensitive, so re-ordering alone does not revoke approval", () => {
    const a = entry({
      resources: [
        { uri: "skill://weather/SKILL.md", digest: DIGEST, size: 100 },
        { uri: "skill://weather/extra.md", digest: DIGEST, size: 1 },
      ],
    });
    const b = entry({
      resources: [
        { uri: "skill://weather/extra.md", digest: DIGEST, size: 1 },
        { uri: "skill://weather/SKILL.md", digest: DIGEST, size: 100 },
      ],
    });
    expect(resourceSetFingerprint(a)).toBe(resourceSetFingerprint(b));
  });

  it("distinguishes a dynamic set from an enumerated one", () => {
    expect(resourceSetFingerprint(entry({ resources: "dynamic" }))).not.toBe(
      resourceSetFingerprint(entry()),
    );
  });
});
