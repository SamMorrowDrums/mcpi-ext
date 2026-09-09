import { CODE_MODE_ERRORS, OUTPUT_BYTE_CAP } from "./budgets.js";
import { loadIsolatedVm, type IsolatedVmIsolate, type IsolatedVmModule } from "./isolated-vm.js";

/** Result of code execution. */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  errorDetails?: CodeModeErrorDetails;
  logs: string[];
}

export interface CodeModeErrorDetails {
  error: string;
  message: string;
  alternatives?: string[];
  toolName?: string;
  reason?: string;
  candidates?: string[];
}

export class CodeModeDispatchError extends Error {
  constructor(readonly details: CodeModeErrorDetails) {
    super(details.message);
    this.name = "CodeModeDispatchError";
  }
}

/** Invoke an MCP tool by canonical `server/tool` reference. */
export type ToolDispatchFn = (reference: string, args: Record<string, unknown>) => Promise<unknown>;

/** Answer a catalog query. Never reaches an MCP server. */
export type DiscoverFn = (operation: string, payload: Record<string, unknown>) => Promise<unknown>;

export interface ExecutorOptions {
  /** Memory limit in MB for the V8 isolate. Default: 128. */
  memoryLimit?: number;
  /** Execution timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
}

export interface SandboxRequest extends ExecutorOptions {
  readonly code: string;
  /** Globally unique alias to canonical ref. Ambiguous names are absent. */
  readonly aliases: Readonly<Record<string, string>>;
  readonly dispatch: ToolDispatchFn;
  readonly discover: DiscoverFn;
  /** Host cancellation. Disposes the isolate and cancels in-flight calls. */
  readonly signal?: AbortSignal;
}

const DEFAULT_MEMORY_LIMIT = 128;
const DEFAULT_TIMEOUT_MS = 30_000;
const STRUCTURED_ERROR_PREFIX = "__CODE_MODE_ERROR__";

/** Error code surfaced when the V8 isolate backend is not installed. */
export const SANDBOX_UNAVAILABLE_ERROR = CODE_MODE_ERRORS.SANDBOX_UNAVAILABLE;

/**
 * Execute model-generated JavaScript in an isolated V8 sandbox.
 *
 * The code runs in a fresh `isolated-vm` isolate with an enforced memory limit,
 * an execution timeout, no Node.js APIs, no filesystem, and no network. The only
 * external surface is the `codemode` namespace, whose calls cross back to the
 * host through `Reference` callbacks — actual MCP execution happens outside.
 *
 * The addon is optional and loaded lazily. When it is unavailable this returns a
 * structured `sandbox_unavailable` error rather than falling back to `node:vm`:
 * `node:vm` shares the host realm and heap, so using it here would silently void
 * the isolation guarantee this API makes.
 */
export async function executeInSandbox(request: SandboxRequest): Promise<ExecuteResult> {
  const memoryLimit = request.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (request.signal?.aborted) return abortedResult();

  const load = await loadIsolatedVm();
  if (!load.available) {
    const message = `Code Mode is unavailable: ${load.reason}. Use tool-cli or the MCP tool proxies instead.`;
    return {
      result: undefined,
      error: message,
      errorDetails: {
        error: SANDBOX_UNAVAILABLE_ERROR,
        message,
        reason: load.reason,
        alternatives: ["tool-cli", "MCP tool proxies"],
      },
      logs: [],
    };
  }

  const ivm = load.module;
  const isolate = new ivm.Isolate({ memoryLimit });

  // Cancellation must not wait for the execution timeout: disposing the isolate
  // stops the running script immediately, and the same signal is forwarded
  // through the policy so in-flight upstream calls are cancelled, not orphaned.
  let disposed = false;
  const disposeOnce = () => {
    if (disposed) return;
    disposed = true;
    try {
      isolate.dispose();
    } catch {
      // Disposing an isolate that already tore itself down is not an error.
    }
  };
  const onAbort = () => {
    disposeOnce();
  };
  request.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    return await runInIsolate(ivm, isolate, request, timeoutMs);
  } catch (error) {
    if (request.signal?.aborted) return abortedResult();
    throw error;
  } finally {
    request.signal?.removeEventListener("abort", onAbort);
    disposeOnce();
  }
}

function abortedResult(): ExecuteResult {
  const message = "Execution was cancelled before it completed.";
  return {
    result: undefined,
    error: message,
    errorDetails: { error: CODE_MODE_ERRORS.CANCELLED, message },
    logs: [],
  };
}

async function runInIsolate(
  ivm: IsolatedVmModule,
  isolate: IsolatedVmIsolate,
  request: SandboxRequest,
  timeoutMs: number,
): Promise<ExecuteResult> {
  const ctx = await isolate.createContext();
  const jail = ctx.global;

  const logs: string[] = [];

  const logCallback = new ivm.Callback((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  await jail.set("__log", logCallback);

  const dispatchRef = new ivm.Reference(async (reference: string, argsJson: string) => {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    try {
      const result = await request.dispatch(reference, args);
      return JSON.stringify({ ok: true, value: result === undefined ? null : result });
    } catch (error) {
      if (error instanceof CodeModeDispatchError) {
        return JSON.stringify({ ok: false, error: error.details });
      }
      throw error;
    }
  });
  await jail.set("__dispatch", dispatchRef);

  const discoverRef = new ivm.Reference(async (operation: string, payloadJson: string) => {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>;
    try {
      const result = await request.discover(operation, payload);
      return JSON.stringify({ ok: true, value: result ?? null });
    } catch (error) {
      if (error instanceof CodeModeDispatchError) {
        return JSON.stringify({ ok: false, error: error.details });
      }
      throw error;
    }
  });
  await jail.set("__discover", discoverRef);

  const aliasEntries = Object.entries(request.aliases)
    .map(
      ([alias, reference]) =>
        `    ${alias}: async (args) => __callTool(${JSON.stringify(reference)}, args)`,
    )
    .join(",\n");

  const normalized = normalizeCode(request.code);

  const wrappedCode = `
    (async () => {
      const console = { log: (...args) => __log(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) };
      const __callTool = async (ref, args) => {
        const r = await __dispatch.apply(undefined, [ref, JSON.stringify(args ?? {})], { arguments: { copy: true }, result: { promise: true, copy: true } });
        const response = JSON.parse(r);
        if (!response.ok) {
          throw new Error(${JSON.stringify(STRUCTURED_ERROR_PREFIX)} + JSON.stringify(response.error));
        }
        return response.value;
      };
      const __ask = async (op, payload) => {
        const r = await __discover.apply(undefined, [op, JSON.stringify(payload ?? {})], { arguments: { copy: true }, result: { promise: true, copy: true } });
        const response = JSON.parse(r);
        if (!response.ok) {
          throw new Error(${JSON.stringify(STRUCTURED_ERROR_PREFIX)} + JSON.stringify(response.error));
        }
        return response.value;
      };
${INSPECT_SOURCE}
      const codemode = {
        browse: async (options) => __ask("browse", options),
        listNamespaces: async (options) => __ask("browse", options),
        list: async (options) => __ask("list", options),
        listTools: async (options) => __ask("list", options),
        search: async (query, options) => __ask("search", { ...(options ?? {}), query }),
        searchTools: async (query, options) => __ask("search", { ...(options ?? {}), query }),
        describe: async (refs) => __ask("describe", { refs: Array.isArray(refs) ? refs : [refs] }),
        describeTools: async (refs) => __ask("describe", { refs: Array.isArray(refs) ? refs : [refs] }),
        call: async (server, tool, args) => __callTool(server + "/" + tool, args),
        callRef: async (ref, args) => __callTool(ref, args),
        inspect: (value, options) => __inspect(value, options),
${aliasEntries}
      };

      const __userFn = async () => {
        ${normalized}
      };

      return JSON.stringify({ value: await __userFn() });
    })()
  `;

  try {
    const rawResult = (await ctx.eval(wrappedCode, {
      promise: true,
      copy: true,
      timeout: timeoutMs,
    })) as string;

    const parsed = JSON.parse(rawResult) as { value: unknown };
    return capOutput(parsed.value, logs);
  } catch (err) {
    if (request.signal?.aborted) return { ...abortedResult(), logs };
    const message = err instanceof Error ? err.message : String(err);
    const errorDetails = parseStructuredError(message);
    return {
      result: undefined,
      error: errorDetails?.message ?? message,
      errorDetails,
      logs,
    };
  }
}

/**
 * Keep a runaway return value from becoming the turn's entire context budget.
 *
 * Reported as an honest budget refusal rather than silently truncated, because
 * a half-serialized object is worse than no object.
 */
function capOutput(value: unknown, logs: string[]): ExecuteResult {
  if (value === undefined) return { result: value, logs };
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return { result: value, logs };

  const bytes = Buffer.byteLength(serialized, "utf8");
  if (bytes <= OUTPUT_BYTE_CAP) return { result: value, logs };

  const message =
    `The returned value is ${String(bytes)} bytes, over the ${String(OUTPUT_BYTE_CAP)}-byte output cap. ` +
    "Aggregate, filter, or paginate inside the sandbox and return a summary instead.";
  return {
    result: undefined,
    error: message,
    errorDetails: { error: CODE_MODE_ERRORS.BUDGET_EXCEEDED, message },
    logs,
  };
}

/**
 * `codemode.inspect` — runtime shape discovery, defined inside the isolate.
 *
 * This is the honest answer to servers that declare no output schema, which is
 * every tool on the released github-mcp-server. Rather than the prompt asserting
 * a shape nobody promised, the model looks at what actually came back. Runs
 * entirely in-isolate: no host call, no egress.
 */
const INSPECT_SOURCE = `
      const __inspect = (value, options) => {
        const maxDepth = (options && options.depth) || 3;
        const maxKeys = (options && options.keys) || 30;
        const maxSample = (options && options.sample) || 3;
        const describe = (v, depth) => {
          if (v === null) return "null";
          if (v === undefined) return "undefined";
          const t = typeof v;
          if (t === "string") return v.length > 60 ? "string(" + v.length + "): " + JSON.stringify(v.slice(0, 60)) + "…" : "string: " + JSON.stringify(v);
          if (t === "number" || t === "boolean") return t + ": " + String(v);
          if (t === "function") return "function";
          if (Array.isArray(v)) {
            if (depth >= maxDepth) return "array(" + v.length + ")";
            const sample = v.slice(0, maxSample).map((item) => describe(item, depth + 1));
            return "array(" + v.length + ")" + (sample.length ? " [" + sample.join(", ") + (v.length > maxSample ? ", …" : "") + "]" : "");
          }
          if (t === "object") {
            if (depth >= maxDepth) return "object";
            const keys = Object.keys(v);
            const shown = keys.slice(0, maxKeys);
            const body = shown.map((k) => k + ": " + describe(v[k], depth + 1)).join(", ");
            return "{ " + body + (keys.length > maxKeys ? ", … " + (keys.length - maxKeys) + " more" : "") + " }";
          }
          return t;
        };
        return describe(value, 0);
      };`;

/**
 * Normalize model-generated code:
 * - Strip markdown code fences
 * - Handle arrow functions, function declarations, export default
 * - Otherwise leave code as a statement block; callers must explicitly `return` a value
 */
export function normalizeCode(code: string): string {
  let normalized = code.trim();

  normalized = normalized.replace(/^```(?:js|javascript|typescript|ts)?\s*\n?/i, "");
  normalized = normalized.replace(/\n?```\s*$/i, "");
  normalized = normalized.trim();

  if (/^(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/.test(normalized)) {
    return `return (${normalized})();`;
  }

  if (/^(?:async\s+)?function\s+/.test(normalized)) {
    const match = normalized.match(/^(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (match) {
      return `${normalized}\nreturn ${match[1]}();`;
    }
  }

  if (/^export\s+default\s+/.test(normalized)) {
    normalized = normalized.replace(/^export\s+default\s+/, "");
    return `return (${normalized})();`;
  }

  return normalized;
}

function parseStructuredError(message: string): CodeModeErrorDetails | undefined {
  const markerIndex = message.indexOf(STRUCTURED_ERROR_PREFIX);
  if (markerIndex === -1) return undefined;

  const serialized = message.slice(markerIndex + STRUCTURED_ERROR_PREFIX.length);
  try {
    const details = JSON.parse(serialized) as Partial<CodeModeErrorDetails>;
    if (typeof details.error !== "string" || typeof details.message !== "string") {
      return undefined;
    }
    return details as CodeModeErrorDetails;
  } catch {
    return undefined;
  }
}
