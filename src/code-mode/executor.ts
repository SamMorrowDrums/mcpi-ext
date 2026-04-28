import ivm from "isolated-vm";
import { sanitizeToolName } from "./type-hints.js";

/** Result of code execution. */
export interface ExecuteResult {
  result: unknown;
  error?: string;
  logs: string[];
}

/** A function the sandbox can call to invoke an MCP tool. */
export type ToolDispatchFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ExecutorOptions {
  /** Memory limit in MB for the V8 isolate. Default: 128. */
  memoryLimit?: number;
  /** Execution timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
}

const DEFAULT_MEMORY_LIMIT = 128;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Execute model-generated JavaScript code in an isolated V8 sandbox.
 *
 * The code runs in a fresh `isolated-vm` isolate with:
 * - Enforced memory limit (default 128MB)
 * - Execution timeout (default 30s)
 * - No access to Node.js APIs, filesystem, or network
 * - Only access to provided tool dispatch functions via `codemode.*` proxy
 *
 * Tool calls are dispatched to the host via `Reference` callbacks —
 * actual MCP tool execution happens outside the sandbox.
 */
export async function executeInSandbox(
  code: string,
  toolNames: string[],
  dispatch: ToolDispatchFn,
  options: ExecutorOptions = {},
): Promise<ExecuteResult> {
  const memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const isolate = new ivm.Isolate({ memoryLimit });
  try {
    return await runInIsolate(isolate, code, toolNames, dispatch, timeoutMs);
  } finally {
    isolate.dispose();
  }
}

async function runInIsolate(
  isolate: ivm.Isolate,
  code: string,
  toolNames: string[],
  dispatch: ToolDispatchFn,
  timeoutMs: number,
): Promise<ExecuteResult> {
  const ctx = await isolate.createContext();
  const jail = ctx.global;

  const logs: string[] = [];

  // Inject console.log that captures to logs array
  const logCallback = new ivm.Callback((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  });
  await jail.set("__log", logCallback);

  // Inject tool dispatcher Reference (async callback)
  const dispatchRef = new ivm.Reference(async (toolName: string, argsJson: string) => {
    const args = JSON.parse(argsJson) as Record<string, unknown>;
    const result = await dispatch(toolName, args);
    return JSON.stringify(result === undefined ? null : result);
  });
  await jail.set("__dispatch", dispatchRef);

  // Build the tool call helper and codemode proxy as setup code
  const toolProxyEntries = toolNames
    .map((name) => {
      const safe = sanitizeToolName(name);
      return `    ${safe}: async (args) => __callTool(${JSON.stringify(name)}, args)`;
    })
    .join(",\n");

  const normalized = normalizeCode(code);

  // Use ctx.eval with { promise: true } instead of compileModule,
  // because module.evaluate() can resolve prematurely with multiple
  // sequential async Reference.apply calls.
  const wrappedCode = `
    (async () => {
      const console = { log: (...args) => __log(args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')) };
      const __callTool = async (name, args) => {
        const r = await __dispatch.apply(undefined, [name, JSON.stringify(args ?? {})], { arguments: { copy: true }, result: { promise: true, copy: true } });
        return JSON.parse(r);
      };
      const codemode = {
        listTools: async () => ${JSON.stringify(toolNames)},
        describeTools: async (names) => "Use the typed codemode.toolName(args) methods instead.",
${toolProxyEntries}
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
    return { result: parsed.value, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: undefined, error: message, logs };
  }
}

/**
 * Normalize model-generated code:
 * - Strip markdown code fences
 * - Handle arrow functions, function declarations, export default
 * - Otherwise leave code as a statement block; callers must explicitly `return` a value
 */
export function normalizeCode(code: string): string {
  let normalized = code.trim();

  // Strip markdown code fences
  normalized = normalized.replace(/^```(?:js|javascript|typescript|ts)?\s*\n?/i, "");
  normalized = normalized.replace(/\n?```\s*$/i, "");
  normalized = normalized.trim();

  // If it's an arrow function or function expression, invoke it
  if (/^(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$][a-zA-Z0-9_$]*)\s*=>/.test(normalized)) {
    return `return (${normalized})();`;
  }

  // If it's a function declaration, invoke it
  if (/^(?:async\s+)?function\s+/.test(normalized)) {
    const match = normalized.match(/^(?:async\s+)?function\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
    if (match) {
      return `${normalized}\nreturn ${match[1]}();`;
    }
  }

  // If it starts with export default, strip the export default
  if (/^export\s+default\s+/.test(normalized)) {
    normalized = normalized.replace(/^export\s+default\s+/, "");
    return `return (${normalized})();`;
  }

  // Otherwise, treat as a code block — return the last expression
  return normalized;
}
