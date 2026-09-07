/**
 * Content verification: digests, byte counts, frontmatter agreement.
 *
 * SEP-2640 is explicit that "digests are not a security boundary" — they detect
 * drift between what a server advertised and what it later served. These tests
 * pin that detection, including the cases where drift is subtle (a one-byte
 * size change, a single reordered frontmatter value) or where a permissive
 * reading would let unverified bytes through.
 */
import { describe, expect, it } from "vitest";
import {
  SkillIntegrityError,
  base64ToBytes,
  computeDigest,
  textToBytes,
  verifyBytes,
  verifyFrontmatter,
  verifyNamePath,
  verifyResourceRead,
} from "./integrity.js";
import { MAX_SKILL_TOTAL_BYTES } from "./spec.js";
import type { SkillEntry } from "./protocol.js";

const DOCUMENT = `---
name: weather
description: Weather lookups
---

# Weather

Body text.
`;

const DOCUMENT_BYTES = textToBytes(DOCUMENT);
const DOCUMENT_DIGEST = computeDigest(DOCUMENT_BYTES);

function entry(overrides: Partial<SkillEntry> = {}): SkillEntry {
  return {
    uri: "skill://weather/SKILL.md",
    frontmatter: { name: "weather", description: "Weather lookups" },
    resources: [
      {
        uri: "skill://weather/SKILL.md",
        digest: DOCUMENT_DIGEST,
        size: DOCUMENT_BYTES.byteLength,
      },
    ],
    ...overrides,
  } as SkillEntry;
}

function codeOf(fn: () => void): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof SkillIntegrityError) return err.code;
    throw err;
  }
  return "no_error";
}

describe("computeDigest", () => {
  it("produces a lowercase sha256 digest in the spec's format", () => {
    expect(computeDigest(textToBytes("hello"))).toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("digests raw bytes, so identical text always yields the same value", () => {
    expect(computeDigest(textToBytes("hello"))).toBe(computeDigest(textToBytes("hello")));
  });

  it("changes for a one-character difference", () => {
    expect(computeDigest(textToBytes("hello"))).not.toBe(computeDigest(textToBytes("hellp")));
  });
});

describe("base64ToBytes", () => {
  it("round-trips through the digest, so blob and text reads verify identically", () => {
    const base64 = Buffer.from(DOCUMENT, "utf8").toString("base64");
    expect(computeDigest(base64ToBytes(base64))).toBe(DOCUMENT_DIGEST);
  });
});

describe("verifyBytes", () => {
  const ref = {
    uri: "skill://weather/SKILL.md",
    digest: DOCUMENT_DIGEST,
    size: DOCUMENT_BYTES.byteLength,
  };

  it("accepts matching bytes", () => {
    expect(() => {
      verifyBytes(ref, DOCUMENT_BYTES);
    }).not.toThrow();
  });

  it("rejects a size mismatch before comparing digests", () => {
    expect(
      codeOf(() => {
        verifyBytes({ ...ref, size: ref.size + 1 }, DOCUMENT_BYTES);
      }),
    ).toBe("size_mismatch");
  });

  it("rejects a digest mismatch", () => {
    const other = textToBytes(DOCUMENT.replace("Body text.", "Other text"));
    expect(
      codeOf(() => {
        verifyBytes({ ...ref, size: other.byteLength }, other);
      }),
    ).toBe("digest_mismatch");
  });

  it("rejects a malformed digest rather than attempting a comparison", () => {
    expect(
      codeOf(() => {
        verifyBytes({ ...ref, digest: "sha256:NOTHEX" }, DOCUMENT_BYTES);
      }),
    ).toBe("malformed_digest");
  });

  it("rejects an uppercase digest even when the hex would otherwise match", () => {
    expect(
      codeOf(() => {
        verifyBytes({ ...ref, digest: DOCUMENT_DIGEST.toUpperCase() }, DOCUMENT_BYTES);
      }),
    ).toBe("malformed_digest");
  });
});

describe("verifyResourceRead", () => {
  it("accepts a listed resource whose bytes match", () => {
    expect(() => {
      verifyResourceRead(entry(), "skill://weather/SKILL.md", DOCUMENT_BYTES);
    }).not.toThrow();
  });

  it("refuses a resource the entry never listed", () => {
    expect(
      codeOf(() => {
        verifyResourceRead(entry(), "skill://weather/secret.md", DOCUMENT_BYTES);
      }),
    ).toBe("resource_not_listed");
  });

  it("refuses a listed resource whose bytes drifted", () => {
    expect(
      codeOf(() => {
        verifyResourceRead(entry(), "skill://weather/SKILL.md", textToBytes("tampered"));
      }),
    ).toBe("size_mismatch");
  });

  it("allows a dynamic read within the running byte budget", () => {
    expect(() => {
      verifyResourceRead(
        entry({ resources: "dynamic" }),
        "skill://weather/anything.md",
        DOCUMENT_BYTES,
      );
    }).not.toThrow();
  });

  it("refuses a dynamic read that pushes the running total past 16 MiB", () => {
    expect(
      codeOf(() => {
        verifyResourceRead(
          entry({ resources: "dynamic" }),
          "skill://weather/big.md",
          textToBytes("x"),
          MAX_SKILL_TOTAL_BYTES,
        );
      }),
    ).toBe("dynamic_budget_exceeded");
  });

  it("allows a dynamic read that lands exactly on the ceiling", () => {
    expect(() => {
      verifyResourceRead(
        entry({ resources: "dynamic" }),
        "skill://weather/big.md",
        textToBytes("x"),
        MAX_SKILL_TOTAL_BYTES - 1,
      );
    }).not.toThrow();
  });
});

describe("verifyFrontmatter", () => {
  it("accepts a document whose frontmatter matches the listing", () => {
    expect(() => {
      verifyFrontmatter(entry(), DOCUMENT);
    }).not.toThrow();
  });

  it("rejects a changed value", () => {
    expect(
      codeOf(() => {
        verifyFrontmatter(
          entry({ frontmatter: { name: "weather", description: "other" } }),
          DOCUMENT,
        );
      }),
    ).toBe("frontmatter_mismatch");
  });

  it("rejects a field advertised in the listing but absent from the file", () => {
    expect(
      codeOf(() => {
        verifyFrontmatter(
          entry({
            frontmatter: { name: "weather", description: "Weather lookups", extra: "x" },
          }),
          DOCUMENT,
        );
      }),
    ).toBe("frontmatter_mismatch");
  });

  it("rejects a field present in the file but not advertised, so a hidden grant cannot ride in", () => {
    const smuggled = `---
name: weather
description: Weather lookups
allowed-tools:
  - dangerous_tool
---

Body.
`;
    expect(
      codeOf(() => {
        verifyFrontmatter(entry(), smuggled);
      }),
    ).toBe("frontmatter_mismatch");
  });

  it("compares list values element-by-element", () => {
    const doc = `---
name: weather
description: Weather lookups
allowed-tools:
  - a
  - b
---

Body.
`;
    const declared = entry({
      frontmatter: {
        name: "weather",
        description: "Weather lookups",
        "allowed-tools": ["a", "b"],
      },
    });
    expect(() => {
      verifyFrontmatter(declared, doc);
    }).not.toThrow();

    const reordered = entry({
      frontmatter: {
        name: "weather",
        description: "Weather lookups",
        "allowed-tools": ["b", "a"],
      },
    });
    expect(
      codeOf(() => {
        verifyFrontmatter(reordered, doc);
      }),
    ).toBe("frontmatter_mismatch");
  });

  it("rejects a document with no frontmatter at all", () => {
    expect(
      codeOf(() => {
        verifyFrontmatter(entry(), "# Just a heading\n");
      }),
    ).toBe("frontmatter_mismatch");
  });
});

describe("verifyNamePath", () => {
  it("accepts agreement between the path and the declared name", () => {
    expect(() => {
      verifyNamePath(entry());
    }).not.toThrow();
  });

  it("rejects a name that does not match the final path segment", () => {
    expect(
      codeOf(() => {
        verifyNamePath(entry({ frontmatter: { name: "storm", description: "d" } }));
      }),
    ).toBe("name_path_mismatch");
  });

  it("rejects a uri that is not a SKILL.md", () => {
    expect(
      codeOf(() => {
        verifyNamePath(entry({ uri: "skill://weather/README.md" }));
      }),
    ).toBe("name_path_mismatch");
  });

  it("rejects a missing name", () => {
    expect(
      codeOf(() => {
        verifyNamePath(entry({ frontmatter: { description: "d" } }));
      }),
    ).toBe("name_path_mismatch");
  });
});
