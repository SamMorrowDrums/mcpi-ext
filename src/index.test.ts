import { describe, it, expect } from "vitest";

describe("mcpi-ext", () => {
  it("exports a default function", async () => {
    const mod = await import("./index.js");
    expect(typeof mod.default).toBe("function");
  });
});
