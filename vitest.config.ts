import { defineConfig } from "vitest/config";

// Vitest 4 narrowed defaultExclude to node_modules and .git, so `dist` is no
// longer excluded for us. The dev build (tsconfig.json) deliberately compiles
// test files, so without an explicit include every suite would be collected
// twice: once from source and once from stale compiled JavaScript in dist.
// Pin the source of truth rather than relying on tool defaults.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "scripts/**/*.test.mjs"],
    exclude: ["**/node_modules/**", "**/.git/**", "dist/**"],
  },
});
