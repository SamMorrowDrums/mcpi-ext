import { describe, it, expect } from "vitest";

describe("pi-mcp-agent", () => {
  it("exports a default function", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.default).toBe("function");
  });
});
