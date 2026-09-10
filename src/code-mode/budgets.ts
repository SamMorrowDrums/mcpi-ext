/**
 * Execution and discovery budgets, and the typed error taxonomy.
 *
 * These are contract, not tuning knobs. A discovery surface that will happily
 * return everything is just eager disclosure with extra steps, so the bounds
 * live in one place where they can be asserted against.
 */

/** Default number of search hits returned when the caller does not ask. */
export const SEARCH_TOP_K_DEFAULT = 5;
/** Hard ceiling on search hits per page. */
export const SEARCH_TOP_K_MAX = 20;
/** Hard ceiling on refs described in one batch. */
export const DESCRIBE_BATCH_MAX = 20;
/** Hard ceiling on tool names listed per page. */
export const LIST_PAGE_MAX = 50;
/** Default tool names listed per page. */
export const LIST_PAGE_DEFAULT = 25;

/** Serialized byte cap for a single discovery response. */
export const DISCOVERY_RESPONSE_BYTE_CAP = 24_000;

/** Maximum MCP tool calls one execution may make. */
export const MAX_CHILD_CALLS = 64;
/** Concurrent read calls allowed against a single server. */
export const MAX_CONCURRENT_READS_PER_SERVER = 8;
/** Writes are serialized globally: one in flight, ever. */
export const MAX_CONCURRENT_WRITES = 1;
/** Automatic retries for read calls, across the whole execution. */
export const MAX_READ_RETRIES_TOTAL = 3;
/** Automatic retries for write calls. Deliberately zero. */
export const MAX_WRITE_RETRIES = 0;

/** Bytes of a single tool result inlined before it spills to a ResultRef. */
export const INLINE_RESULT_BYTE_CAP = 8_000;
/** Bytes of the final execution return value returned inline. */
export const OUTPUT_BYTE_CAP = 48_000;

/**
 * Typed error taxonomy.
 *
 * Every refusal names its kind so the model can tell "you may not" from
 * "you asked wrong" from "it broke", and so failures never arrive disguised
 * as a successful text result.
 */
export const CODE_MODE_ERRORS = Object.freeze({
  /** Reference did not resolve to any catalog entry. */
  UNKNOWN_TOOL: "unknown_tool",
  /** Bare name matched more than one server. */
  AMBIGUOUS_TOOL: "ambiguous_tool",
  /** Arguments failed validation before any policy or server call. */
  INVALID_ARGUMENTS: "invalid_arguments",
  /** Server declared an output schema and then violated it. */
  INVALID_STRUCTURED_CONTENT: "invalid_structured_content",
  /** Policy refused the call. */
  PERMISSION_DENIED: "permission_denied",
  /** Discovery-only surface tried to reach a server. */
  DISPATCH_UNAVAILABLE: "dispatch_unavailable_in_search",
  /** Cursor does not belong to this snapshot, query, filter, or page size. */
  STALE_CURSOR: "stale_cursor",
  /** Pinned snapshot is no longer available. */
  STALE_SNAPSHOT: "stale_snapshot",
  /** Tool schema changed between describe and call. */
  SCHEMA_CHANGED: "schema_changed",
  /** Execution exceeded a declared budget. */
  BUDGET_EXCEEDED: "budget_exceeded",
  /** Host or caller cancelled. */
  CANCELLED: "cancelled",
  /** Wall-clock deadline elapsed. */
  DEADLINE_EXCEEDED: "deadline_exceeded",
  /** The optional isolate backend is not installed. */
  SANDBOX_UNAVAILABLE: "sandbox_unavailable",
  /** Upstream server or transport failed. */
  UPSTREAM_ERROR: "upstream_error",
} as const);

export type CodeModeErrorCode = (typeof CODE_MODE_ERRORS)[keyof typeof CODE_MODE_ERRORS];

/** Clamp a caller-supplied bound to its contract range. */
export function clampBound(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  const rounded = Math.floor(value);
  if (rounded < 1) return 1;
  return rounded > max ? max : rounded;
}
