import { describe, it, expect } from "vitest";
import {
  parseJsonlLine,
  extractAssistantText,
  extractUsage,
  extractModel,
  buildDockerArgs,
} from "./docker-e2e.js";

describe("parseJsonlLine", () => {
  it("parses valid JSON event", () => {
    const line = '{"type":"message_start","message":{"role":"assistant"}}';
    const result = parseJsonlLine(line);
    expect(result).not.toBeNull();
    expect(result?.type).toBe("message_start");
    expect(result?.raw).toBe(line);
  });

  it("returns raw type for non-JSON", () => {
    const result = parseJsonlLine("some plain text output");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("raw");
    expect(result?.raw).toBe("some plain text output");
  });

  it("returns null for empty lines", () => {
    expect(parseJsonlLine("")).toBeNull();
    expect(parseJsonlLine("   ")).toBeNull();
  });

  it("defaults to unknown type when type field missing", () => {
    const result = parseJsonlLine('{"data":"hello"}');
    expect(result?.type).toBe("unknown");
  });
});

describe("extractAssistantText", () => {
  it("extracts text from message_end events", () => {
    const log = [
      {
        type: "message_end",
        timestamp: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Hello world" }],
          },
        }),
      },
    ];
    expect(extractAssistantText(log)).toBe("Hello world");
  });

  it("concatenates multiple assistant messages", () => {
    const makeEnd = (text: string) => ({
      type: "message_end",
      timestamp: 0,
      raw: JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
      }),
    });
    const log = [makeEnd("First"), makeEnd("Second")];
    expect(extractAssistantText(log)).toBe("First\nSecond");
  });

  it("ignores non-assistant messages", () => {
    const log = [
      {
        type: "message_end",
        timestamp: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: {
            role: "user",
            content: [{ type: "text", text: "ignored" }],
          },
        }),
      },
    ];
    expect(extractAssistantText(log)).toBe("");
  });

  it("ignores non-message_end events", () => {
    const log = [{ type: "message_start", timestamp: 0, raw: "{}" }];
    expect(extractAssistantText(log)).toBe("");
  });
});

describe("extractUsage", () => {
  it("accumulates usage from assistant messages", () => {
    const log = [
      {
        type: "message_end",
        timestamp: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 100,
              output: 50,
              cacheRead: 10,
              cacheWrite: 5,
              cost: { total: 0.01 },
            },
          },
        }),
      },
      {
        type: "message_end",
        timestamp: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 200,
              output: 100,
              cacheRead: 20,
              cacheWrite: 10,
              cost: { total: 0.02 },
            },
          },
        }),
      },
    ];
    const usage = extractUsage(log);
    expect(usage.turns).toBe(2);
    expect(usage.input).toBe(300);
    expect(usage.output).toBe(150);
    expect(usage.cacheRead).toBe(30);
    expect(usage.cacheWrite).toBe(15);
    expect(usage.cost).toBeCloseTo(0.03);
  });

  it("returns zeroes for empty log", () => {
    const usage = extractUsage([]);
    expect(usage.turns).toBe(0);
    expect(usage.input).toBe(0);
  });
});

describe("extractModel", () => {
  it("extracts model from message_end", () => {
    const log = [
      {
        type: "message_end",
        timestamp: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: { model: "claude-sonnet-4-5", role: "assistant", content: [] },
        }),
      },
    ];
    expect(extractModel(log)).toBe("claude-sonnet-4-5");
  });

  it("returns undefined for empty log", () => {
    expect(extractModel([])).toBeUndefined();
  });
});

describe("buildDockerArgs", () => {
  it("builds basic args", () => {
    const args = buildDockerArgs("my-image", {
      task: "Fix the bug",
      token: "ghp_abc123",
    });
    expect(args).toEqual([
      "run",
      "--rm",
      "-e",
      "GITHUB_TOKEN=ghp_abc123",
      "my-image",
      "Fix the bug",
    ]);
  });

  it("includes model env var when specified", () => {
    const args = buildDockerArgs("my-image", {
      task: "Fix it",
      token: "ghp_abc",
      model: "claude-opus-4-5",
    });
    expect(args).toContain("-e");
    expect(args).toContain("PI_MODEL=claude-opus-4-5");
  });
});
