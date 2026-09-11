import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Read the config off disk rather than importing it. Vitest resolves its own
// config through a cache, so an `import` here keeps returning the copy loaded
// at startup and would pass even against a regressed file on disk.
const CONFIG_PATH = fileURLToPath(new URL("../vitest.config.ts", import.meta.url));

// This suite guards a defect that was invisible until dist/ happened to exist:
// Vitest 4 narrowed defaultExclude to node_modules and .git, so an absent or
// weakened config silently collects the compiled copies in dist/ as well. Every
// suite then runs twice, and half of those runs execute stale JavaScript rather
// than the source under test.
describe("vitest configuration", () => {
  const source = readFileSync(CONFIG_PATH, "utf8");

  it("collects source tests and release workflow tests only", () => {
    expect(source).toContain('include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"]');
  });

  it("excludes the build output", () => {
    expect(source).toContain('"dist/**"');
  });

  it("never widens collection to the repository root", () => {
    expect(source).not.toContain('include: ["**/*.test.ts"]');
  });
});
