import { SdkErrorCode, SdkHttpError, type FetchLike } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import {
  McpRateLimitError,
  declaredRateLimitDelayMs,
  toMcpRateLimitError,
  withMcpRateLimitSignals,
} from "./rate-limit.js";

describe("structured MCP rate-limit signals", () => {
  it("preserves HTTP retry and reset headers before the transport discards them", async () => {
    const fetchFn = vi.fn<FetchLike>(async () => {
      return new Response(null, {
        status: 429,
        headers: {
          "retry-after": "2",
          "ratelimit-reset": "3",
          "x-ratelimit-reset": "104",
        },
      });
    });

    const error = await withMcpRateLimitSignals(fetchFn)(new URL("https://mcp.example.test")).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(McpRateLimitError);
    expect(error).toMatchObject({
      status: 429,
      retryAfter: "2",
      rateLimitResetAfter: "3",
      rateLimitResetAt: "104",
    });
  });

  it("uses the most conservative standard/provider reset signal", () => {
    expect(
      declaredRateLimitDelayMs(
        {
          retryAfter: "2",
          rateLimitResetAfter: "3",
          rateLimitResetAt: "104",
        },
        100_000,
      ),
    ).toBe(4_000);
  });

  it("accepts Retry-After HTTP dates", () => {
    expect(declaredRateLimitDelayMs({ retryAfter: new Date(103_000).toUTCString() }, 100_000)).toBe(
      3_000,
    );
  });

  it("ignores malformed metadata instead of parsing arbitrary text", () => {
    expect(
      declaredRateLimitDelayMs(
        {
          retryAfter: "rate limit; try tomorrow",
          rateLimitResetAfter: "1.5",
          rateLimitResetAt: "soon",
        },
        100_000,
      ),
    ).toBeUndefined();
  });

  it("normalizes only an SDK HTTP 429", () => {
    const rateLimited = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Error POSTing to endpoint",
      { status: 429 },
    );
    const unavailable = new SdkHttpError(
      SdkErrorCode.ClientHttpNotImplemented,
      "Error POSTing to endpoint",
      { status: 503 },
    );

    expect(toMcpRateLimitError(rateLimited)).toBeInstanceOf(McpRateLimitError);
    expect(toMcpRateLimitError(unavailable)).toBeUndefined();
    expect(toMcpRateLimitError(new Error("HTTP 429 rate limit"))).toBeUndefined();
  });
});
