import { SdkHttpError, type FetchLike } from "@modelcontextprotocol/client";

export interface McpRateLimitSignal {
  readonly retryAfter?: string;
  readonly rateLimitResetAfter?: string;
  readonly rateLimitResetAt?: string;
}

/** Structured HTTP 429 information preserved before the MCP transport discards response headers. */
export class McpRateLimitError extends Error implements McpRateLimitSignal {
  readonly status = 429;
  readonly retryAfter?: string;
  readonly rateLimitResetAfter?: string;
  readonly rateLimitResetAt?: string;

  constructor(signal: McpRateLimitSignal = {}) {
    super("MCP transport was rate limited (HTTP 429)");
    this.name = "McpRateLimitError";
    this.retryAfter = signal.retryAfter;
    this.rateLimitResetAfter = signal.rateLimitResetAfter;
    this.rateLimitResetAt = signal.rateLimitResetAt;
  }
}

/**
 * Preserve retry headers from a Streamable HTTP response before the SDK turns
 * it into an error carrying only status, status text, and body text.
 */
export function withMcpRateLimitSignals(fetchFn: FetchLike): FetchLike {
  return async (input, init) => {
    const response = await fetchFn(input, init);
    if (response.status !== 429) return response;

    await response.body?.cancel().catch(() => undefined);
    throw new McpRateLimitError({
      ...header(response, "retry-after", "retryAfter"),
      ...header(response, "ratelimit-reset", "rateLimitResetAfter"),
      ...header(response, "x-ratelimit-reset", "rateLimitResetAt"),
    });
  };
}

/** Normalize only reliable transport-level 429 signals. */
export function toMcpRateLimitError(error: unknown): McpRateLimitError | undefined {
  if (error instanceof McpRateLimitError) return error;
  if (SdkHttpError.isInstance(error) && error.status === 429) return new McpRateLimitError();
  return undefined;
}

/** Delay declared by standard Retry-After/RateLimit-Reset or GitHub's reset epoch. */
export function declaredRateLimitDelayMs(
  signal: McpRateLimitSignal,
  nowMs: number,
): number | undefined {
  const candidates = [
    parseRetryAfter(signal.retryAfter, nowMs),
    parseDeltaSeconds(signal.rateLimitResetAfter),
    parseEpochSeconds(signal.rateLimitResetAt, nowMs),
  ].filter((value): value is number => value !== undefined);

  return candidates.length === 0 ? undefined : Math.max(...candidates);
}

function header<K extends keyof McpRateLimitSignal>(
  response: Response,
  name: string,
  key: K,
): Pick<McpRateLimitSignal, K> | Record<string, never> {
  const value = response.headers.get(name);
  return value === null ? {} : ({ [key]: value } as Pick<McpRateLimitSignal, K>);
}

function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  const seconds = parseDeltaSeconds(value);
  if (seconds !== undefined) return seconds;
  if (value === undefined) return undefined;

  const dateMs = Date.parse(value);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - nowMs) : undefined;
}

function parseDeltaSeconds(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : undefined;
}

function parseEpochSeconds(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? Math.max(0, seconds * 1_000 - nowMs) : undefined;
}
