/**
 * Lazy adapter for the optional `isolated-vm` native addon.
 *
 * Code Mode is the only feature that needs a real V8 isolate. `isolated-vm` is a
 * native addon, so it can legitimately be absent: an unsupported platform, a
 * missing prebuild with no toolchain to compile one, or a deliberate
 * `--omit=optional` install. When that happens Code Mode must report itself
 * unavailable and the rest of the extension — skills, tool-cli, routing — must
 * keep working.
 *
 * Two rules govern this module:
 *
 * 1. **No top-level import.** The specifier is resolved through a dynamic
 *    `import()` behind a variable so neither Node nor TypeScript binds to the
 *    addon at module-evaluation time. Loading the extension never throws
 *    because a native addon is missing.
 * 2. **Never fall back to Node's `vm`.** `node:vm` shares the host heap and
 *    realm; it is a code-organisation tool, not a security boundary. Silently
 *    downgrading to it would turn "sandboxed execution" into a false claim.
 *    If the addon is absent, Code Mode is unavailable — full stop.
 */

/** The subset of the `isolated-vm` surface Code Mode actually uses. */
export interface IsolatedVmContext {
  readonly global: { set(name: string, value: unknown): Promise<void> };
  eval(code: string, options: { promise: true; copy: true; timeout: number }): Promise<unknown>;
}

export interface IsolatedVmIsolate {
  createContext(): Promise<IsolatedVmContext>;
  dispose(): void;
}

export interface IsolatedVmModule {
  Isolate: new (options: { memoryLimit: number }) => IsolatedVmIsolate;
  Callback: new (fn: (...args: never[]) => unknown) => unknown;
  Reference: new (fn: (...args: never[]) => unknown) => unknown;
}

/** Outcome of attempting to load the native addon. */
export type IsolatedVmLoad =
  | { readonly available: true; readonly module: IsolatedVmModule }
  | { readonly available: false; readonly reason: string };

/**
 * Resolved through a variable rather than a string literal so that TypeScript
 * does not require `isolated-vm` types to be present to build, and so no
 * bundler or loader statically links the addon into the module graph.
 */
const ISOLATED_VM_SPECIFIER = "isolated-vm";

const MISSING_MODULE_CODES = new Set([
  "ERR_MODULE_NOT_FOUND",
  "MODULE_NOT_FOUND",
  "ERR_DLOPEN_FAILED",
]);

let cached: IsolatedVmLoad | undefined;
let inFlight: Promise<IsolatedVmLoad> | undefined;

/**
 * Load the native addon at most once per process.
 *
 * The result — success *or* failure — is cached. A failed load is not retried:
 * a missing or broken native addon does not become present later in the same
 * process, and retrying would repeat the cost on every Code Mode call.
 */
export async function loadIsolatedVm(): Promise<IsolatedVmLoad> {
  if (cached) return cached;
  inFlight ??= attemptLoad().then((result) => {
    cached = result;
    inFlight = undefined;
    return result;
  });
  return inFlight;
}

/** Synchronously report a previously resolved load, if one has happened. */
export function peekIsolatedVm(): IsolatedVmLoad | undefined {
  return cached;
}

/** Reset the memoised state. Test-only. */
export function resetIsolatedVmCacheForTests(): void {
  cached = undefined;
  inFlight = undefined;
}

/** Seed the memoised state. Test-only — lets tests simulate an absent addon. */
export function setIsolatedVmForTests(load: IsolatedVmLoad): void {
  cached = load;
  inFlight = undefined;
}

async function attemptLoad(): Promise<IsolatedVmLoad> {
  try {
    const imported: unknown = await import(ISOLATED_VM_SPECIFIER);
    const candidate = unwrapDefault(imported);
    if (!isIsolatedVmModule(candidate)) {
      return {
        available: false,
        reason:
          "the optional isolated-vm addon loaded but did not expose the expected Isolate/Callback/Reference API",
      };
    }
    return { available: true, module: candidate };
  } catch (error) {
    return { available: false, reason: describeLoadFailure(error) };
  }
}

function unwrapDefault(imported: unknown): unknown {
  if (typeof imported !== "object" || imported === null) return imported;
  const namespace = imported as { default?: unknown };
  return namespace.default ?? imported;
}

function isIsolatedVmModule(value: unknown): value is IsolatedVmModule {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IsolatedVmModule>;
  return (
    typeof candidate.Isolate === "function" &&
    typeof candidate.Callback === "function" &&
    typeof candidate.Reference === "function"
  );
}

/**
 * Turn a load failure into a reason a human can act on.
 *
 * The two failure shapes are meaningfully different: "not installed" is fixed
 * by installing it, while "installed but failed to load" points at an ABI or
 * platform mismatch and needs a rebuild.
 */
function describeLoadFailure(error: unknown): string {
  const code = getErrorCode(error);
  const detail = error instanceof Error ? error.message : String(error);

  if (code && MISSING_MODULE_CODES.has(code)) {
    return `the optional isolated-vm native addon is not installed or failed to load (${code}: ${detail})`;
  }
  return `the optional isolated-vm native addon could not be loaded (${detail})`;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
