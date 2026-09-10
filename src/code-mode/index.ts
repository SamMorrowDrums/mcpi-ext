import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicyError, type McpPolicy } from "../mcp/policy.js";
import { CODE_MODE_ERRORS, MAX_CHILD_CALLS, MAX_CONCURRENT_READS_PER_SERVER } from "./budgets.js";
import {
  buildCatalogSnapshot,
  resolveIdentity,
  resolveTool,
  type CatalogSnapshot,
  type ServerTrust,
  type ServerTrustConfig,
} from "./catalog.js";
import {
  browseNamespaces,
  describeTools as describeFromCatalog,
  listTools as listFromCatalog,
  searchTools as searchFromCatalog,
} from "./discovery.js";
import {
  getCodeModeDiagnostics,
  getCodeModeTools,
  type CodeModeDiagnostics,
  type CodeModeTool,
} from "./eligibility.js";
import type { ExecuteResult, ExecutorOptions } from "./executor.js";
import {
  CodeModeDispatchError,
  executeInSandbox,
  type CodeModeErrorDetails,
  type RunProvenance,
  type ToolTarget,
} from "./executor.js";
import { loadIsolatedVm } from "./isolated-vm.js";
import type { OperatorNamespaces } from "./namespaces.js";
import { renderPromptSection } from "./prompt.js";
import { DiscoveryTelemetry, type DiscoveryFunnel } from "./telemetry.js";
import { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";

export {
  APPROVAL_POSTURE_SCHEMA_VERSION,
  APPROVAL_REASON_ORDER,
  SYNTHESIZED_OUTPUT_SCHEMA,
  approvalPosture,
  getCodeModeDiagnostics,
  getCodeModeTools,
  serializeApprovalPosture,
  toCodeModeTool,
} from "./eligibility.js";
export type {
  CodeModeApprovalPosture,
  CodeModeApprovalReason,
  CodeModeDiagnostics,
  CodeModeEffectClass,
  CodeModeTool,
  OutputSchemaProvenance,
} from "./eligibility.js";
export type {
  CodeModeErrorDetails,
  ExecuteResult,
  ExecutorOptions,
  SandboxRequest,
} from "./executor.js";
export { SANDBOX_UNAVAILABLE_ERROR, executeInSandbox, normalizeCode } from "./executor.js";
export type { RunProvenance } from "./executor.js";
export {
  loadIsolatedVm,
  peekIsolatedVm,
  resetIsolatedVmCacheForTests,
  setIsolatedVmForTests,
  type IsolatedVmLoad,
  type IsolatedVmModule,
} from "./isolated-vm.js";
export { createCodeExecuteTool, createCodeSearchTool } from "./tools.js";
export { jsonSchemaToTypeString } from "./json-schema-to-ts.js";
export {
  DEFAULT_SERVER_TRUST,
  buildCatalogSnapshot,
  canonicalRef,
  identityKey,
  resolveIdentity,
  resolveTool,
  toolEffect,
  type CatalogEntry,
  type CatalogSnapshot,
  type ServerTrust,
  type ServerTrustConfig,
  type ToolIdentity,
} from "./catalog.js";
export { CODE_MODE_ERRORS, type CodeModeErrorCode } from "./budgets.js";
export { renderNamespaceBlock, renderPromptSection, hashNamespaceBlock } from "./prompt.js";
export { renderCompactSignature, renderSearchRow } from "./signatures.js";
export { deriveNamespaces, readToolsetDeclaration, type NamespaceSummary } from "./namespaces.js";
export { DiscoveryTelemetry, type DiscoveryFunnel } from "./telemetry.js";
export type { DiscoveryQuery } from "./tools.js";

export interface CodeModeManagerOptions extends ExecutorOptions {
  /** Log function for status messages. */
  log?: (msg: string) => void;
  /** Test seam for proving pre-isolate refusals. */
  sandboxExecutor?: typeof executeInSandbox;
  /** Operator-curated namespace declarations, keyed by server name. */
  namespaces?: OperatorNamespaces;
  /** Operator-declared trust levels, keyed by server name. */
  trust?: ServerTrustConfig;
}

/**
 * Whether the sandbox backend can run code.
 *
 * `unknown` is a real state, not a synonym for unavailable: before the optional
 * native addon has been probed we have not established anything, and reporting
 * that honestly is better than guessing in either direction.
 */
export interface SandboxAvailability {
  readonly state: "available" | "unavailable" | "unknown";
  readonly reason: string;
}

const SANDBOX_UNPROBED: SandboxAvailability = {
  state: "unknown",
  reason: "the isolated-vm native addon has not been probed yet",
};

const SANDBOX_INJECTED: SandboxAvailability = {
  state: "available",
  reason: "a sandbox executor was supplied directly, bypassing the isolated-vm addon",
};

const SANDBOX_NATIVE: SandboxAvailability = {
  state: "available",
  reason: "the isolated-vm native addon loaded",
};

/**
 * Orchestrates code mode: owns the catalog snapshot, answers discovery queries,
 * and executes model-generated code with policy-checked tool dispatch.
 */
export class CodeModeManager {
  private mcpManager: McpClientManager | null = null;
  private policy: McpPolicy | null = null;
  private codeModeTools: CodeModeTool[] = [];
  private diagnostics: CodeModeDiagnostics = getCodeModeDiagnostics([]);
  private snapshot: CatalogSnapshot = buildCatalogSnapshot([]);
  private pinnedSection: string | undefined;
  private pinnedSnapshotId: string | undefined;
  private readonly telemetry = new DiscoveryTelemetry();
  private readonly options: CodeModeManagerOptions;
  private readonly sandboxExecutor: typeof executeInSandbox;
  private log: ((msg: string) => void) | undefined;
  private lastDiagnosticSummary = "";
  private sandbox: SandboxAvailability;
  private sandboxProbe: Promise<SandboxAvailability> | undefined;
  private operatorNamespaces: OperatorNamespaces | undefined;
  private serverTrust: ServerTrustConfig | undefined;

  constructor(options: CodeModeManagerOptions = {}) {
    this.options = options;
    this.sandboxExecutor = options.sandboxExecutor ?? executeInSandbox;
    this.log = options.log;
    // An injected executor is the sandbox. Probing the native addon in that
    // case would report on a backend this manager will never call.
    this.sandbox = options.sandboxExecutor ? SANDBOX_INJECTED : SANDBOX_UNPROBED;
    this.operatorNamespaces = options.namespaces;
    this.serverTrust = options.trust;
  }

  /**
   * Whether code mode should be advertised to the model.
   *
   * Only a *proven* unavailable sandbox switches this off. An unprobed backend
   * stays active because `code_execute` is registered synchronously at load and
   * returns a structured `sandbox_unavailable` error if it turns out it cannot
   * run — a truthful refusal at call time beats hiding a facility that works.
   */
  get isActive(): boolean {
    return this.sandbox.state !== "unavailable";
  }

  /** Current sandbox backend availability, without triggering a probe. */
  getSandboxAvailability(): SandboxAvailability {
    return this.sandbox;
  }

  /**
   * Load the optional native addon once and cache the verdict.
   *
   * Safe to call from any lifecycle hook; concurrent callers share one probe.
   */
  async probeSandbox(): Promise<SandboxAvailability> {
    if (this.sandbox.state !== "unknown") return this.sandbox;
    this.sandboxProbe ??= loadIsolatedVm().then((load) => {
      this.sandbox = load.available
        ? SANDBOX_NATIVE
        : { state: "unavailable", reason: load.reason };
      if (!load.available) {
        this.log?.(
          `[code-mode] disabled: ${load.reason}. Skills, tool-cli, and routing are unaffected.`,
        );
      }
      return this.sandbox;
    });
    return this.sandboxProbe;
  }

  /**
   * Supply operator-curated namespaces, which rank below server-declared
   * metadata and above the server-only fallback. Call before `initialize`.
   */
  configureNamespaces(namespaces: OperatorNamespaces | undefined): void {
    this.operatorNamespaces = namespaces;
  }

  /** Supply operator-declared server trust levels. Call before `initialize`. */
  configureTrust(trust: ServerTrustConfig | undefined): void {
    this.serverTrust = trust;
  }

  /** Initialize with MCP manager and policy, and build the first snapshot. */
  initialize(mcpManager: McpClientManager, policy: McpPolicy, log?: (msg: string) => void): void {
    this.mcpManager = mcpManager;
    this.policy = policy;
    this.log = log ?? this.log;
    this.refresh();
  }

  /**
   * Rebuild the catalog snapshot (call on tools/list_changed).
   *
   * Deliberately does not touch the pinned prompt. A server that connects at
   * turn 20 becomes reachable through search and describe immediately, but
   * rewriting the system prompt mid-conversation would invalidate the provider
   * prefix cache for every remaining turn — paying a large, permanent cost to
   * announce something discovery already surfaces on demand.
   */
  refresh(): void {
    this.codeModeTools = this.mcpManager ? getCodeModeTools(this.mcpManager) : [];
    this.diagnostics = getCodeModeDiagnostics(this.codeModeTools);

    const previous = this.snapshot.snapshotId;
    this.snapshot = buildCatalogSnapshot(this.codeModeTools, {
      ...(this.operatorNamespaces ? { operator: this.operatorNamespaces } : {}),
      ...(this.serverTrust ? { trust: this.serverTrust } : {}),
    });

    if (this.pinnedSnapshotId && this.snapshot.snapshotId !== previous) {
      this.log?.(
        `[code-mode] catalog changed (${this.snapshot.entries.length} tool(s), snapshot ` +
          `${this.snapshot.snapshotId.slice(0, 12)}). Reachable via code_search; the pinned prompt is unchanged.`,
      );
    }

    const summary =
      `[code-mode] ${this.diagnostics.totalTools} tool(s) across ` +
      `${this.snapshot.servers.length} server(s), ${this.snapshot.namespaces.length} namespace(s); ` +
      `${this.diagnostics.unattendedTools} unattended, ${this.diagnostics.approvalGatedTools} approval-gated; ` +
      `output schemas: ${this.diagnostics.declaredOutputSchemas} declared, ` +
      `${this.diagnostics.synthesizedOutputSchemas} synthesized, ` +
      `${this.diagnostics.unavailableOutputSchemas} unavailable`;
    if (summary !== this.lastDiagnosticSummary) {
      this.log?.(summary);
      this.lastDiagnosticSummary = summary;
    }
  }

  /** The current catalog snapshot. */
  getSnapshot(): CatalogSnapshot {
    return this.snapshot;
  }

  /** Discovery funnel counters, including blind-call rate. */
  getTelemetry(): DiscoveryFunnel {
    return this.telemetry.read();
  }

  /** Tools that dispatch from the sandbox without a human approval prompt. */
  getUnattendedTools(): McpTool[] {
    return this.codeModeTools.filter((entry) => entry.runsUnattended).map((entry) => entry.tool);
  }

  /** Get the complete client-internal catalog, including approval and schema provenance. */
  getCatalogTools(): readonly CodeModeTool[] {
    return this.codeModeTools;
  }

  getDiagnostics(): CodeModeDiagnostics {
    return this.diagnostics;
  }

  /** Create the Pi tool definitions for code_search and code_execute. */
  createTools() {
    return {
      codeSearch: createCodeSearchTool(this),
      codeExecute: createCodeExecuteTool(this),
    };
  }

  /**
   * Freeze the system prompt section for the session.
   *
   * Called once, at session start. Every later turn returns these exact bytes.
   */
  pinPromptSnapshot(): string {
    this.pinnedSection ??= renderPromptSection({
      namespaces: this.snapshot.namespaces,
      sandboxAvailable: this.sandbox.state !== "unavailable",
    });
    this.pinnedSnapshotId ??= this.snapshot.snapshotId;
    return this.pinnedSection;
  }

  /** The pinned system prompt section. Byte-identical for the whole session. */
  formatSystemPromptSection(): string {
    return this.pinPromptSnapshot();
  }

  /**
   * Answer a catalog query.
   *
   * The single discovery entry point, shared by the structured `code_search`
   * tool and the sandbox's `codemode.*` discovery bindings, so both surfaces
   * see identical results and both are counted in the same funnel.
   *
   * Never reaches an MCP server.
   */
  discover(
    operation: string,
    payload: Record<string, unknown> = {},
    pinned?: CatalogSnapshot,
  ): unknown {
    if (!pinned) this.refresh();
    const snapshot = pinned ?? this.snapshot;

    switch (operation) {
      case "browse": {
        this.telemetry.recordBrowse();
        const parent = typeof payload.parent === "string" ? payload.parent : undefined;
        return browseNamespaces(snapshot, parent ? { parent } : {});
      }
      case "list": {
        this.telemetry.recordList();
        return listFromCatalog(snapshot, readOptions(payload));
      }
      case "search": {
        this.telemetry.recordSearch();
        const query = typeof payload.query === "string" ? payload.query : "";
        return searchFromCatalog(snapshot, query, readOptions(payload));
      }
      case "describe": {
        const refs = Array.isArray(payload.refs)
          ? payload.refs.filter((ref): ref is string => typeof ref === "string")
          : [];
        const result = describeFromCatalog(snapshot, refs);
        if ("signatures" in result) {
          this.telemetry.recordDescribe(
            result.signatures.map((entry) => ({ ref: entry.ref, schemaHash: entry.schemaHash })),
          );
        }
        return result;
      }
      default:
        return {
          error: CODE_MODE_ERRORS.INVALID_ARGUMENTS,
          message: `Unknown discovery operation "${operation}". Use browse, search, list, or describe.`,
        };
    }
  }

  /**
   * Execute code that chains MCP tool calls.
   *
   * `expectedSnapshotId` pins the run to the catalog the model actually looked
   * at. Describing a tool in one turn and calling it in the next is otherwise a
   * race: the schema can change in between, and the call would be made against
   * a shape nobody checked. Supplying it turns that into a refusal before the
   * isolate starts; omitting it captures whatever is current.
   */
  async executeCode(
    code: string,
    signal?: AbortSignal,
    expectedSnapshotId?: string,
  ): Promise<ExecuteResult> {
    this.refresh();

    if (expectedSnapshotId && expectedSnapshotId !== this.snapshot.snapshotId) {
      const message =
        `The catalog changed since snapshot ${expectedSnapshotId.slice(0, 12)} ` +
        `(now ${this.snapshot.snapshotId.slice(0, 12)}). Re-run code_search and check the ` +
        "parameters you depend on before executing.";
      return {
        result: undefined,
        error: message,
        errorDetails: { error: CODE_MODE_ERRORS.STALE_SNAPSHOT, message },
        logs: [],
      };
    }

    return this.execute(code, signal);
  }

  private async execute(code: string, signal?: AbortSignal): Promise<ExecuteResult> {
    const policy = this.policy;
    // Captured once. Every discovery, binding, and dispatch in this run reads
    // this exact catalog, so the run is internally consistent even if a server
    // reconnects underneath it.
    const snapshot = this.snapshot;

    const aliases: Record<string, string> = {};
    for (const [alias, entry] of snapshot.byAlias) aliases[alias] = entry.ref;

    let childCalls = 0;
    const readSlots = new Map<string, number>();
    const writeQueue = { chain: Promise.resolve() };

    // Coarse run-level provenance. Recorded before dispatch so that a write
    // is judged against everything the run had already read, not against
    // whatever happened to complete first.
    const readServers = new Map<string, ServerTrust>();
    let attemptedWrite = false;

    const dispatch = async (target: ToolTarget, args: Record<string, unknown>) => {
      if (signal?.aborted) throw cancelled();

      childCalls += 1;
      if (childCalls > MAX_CHILD_CALLS) {
        throw new CodeModeDispatchError({
          error: CODE_MODE_ERRORS.BUDGET_EXCEEDED,
          message: `This execution exceeded its budget of ${String(MAX_CHILD_CALLS)} tool calls. Narrow the query or paginate more coarsely.`,
        });
      }

      // Authority comes from the structured identity where the script gave
      // one. A ref is resolved through the catalog, never parsed into one.
      const resolved =
        target.kind === "identity"
          ? resolveIdentity(snapshot, target)
          : resolveTool(snapshot, target.ref);
      if (!resolved.ok) {
        throw new CodeModeDispatchError({
          error: resolved.error,
          message: resolved.message,
          ...(resolved.candidates ? { candidates: [...resolved.candidates] } : {}),
        });
      }

      const entry = resolved.entry;
      if (!policy) throw new Error("Code mode MCP policy is not initialized");

      // Described in an earlier turn, changed since. The model's arguments were
      // shaped against something that no longer exists, so retrying the same
      // call cannot succeed — say what happened and send it back to describe.
      const describedHash = this.telemetry.describedSchemaHash(entry.ref);
      if (describedHash !== undefined && describedHash !== entry.schemaHash) {
        throw new CodeModeDispatchError({
          error: CODE_MODE_ERRORS.SCHEMA_CHANGED,
          message:
            `The schema for ${entry.ref} changed since you described it. ` +
            "Call code_search with op=describe for this tool and rebuild the arguments; " +
            "re-running the same call will fail the same way.",
        });
      }

      this.telemetry.recordCall(entry.ref);

      if (entry.effect === "read") readServers.set(entry.serverName, entry.trust);
      else attemptedWrite = true;

      const call = async () => {
        try {
          const terminal = await policy.callTool({
            source: "code-mode",
            serverName: entry.serverName,
            toolName: entry.toolName,
            args,
            ...(signal !== undefined ? { signal } : {}),
          });
          return terminal.result;
        } catch (error) {
          throw toCodeModeDispatchError(error, entry);
        }
      };

      // Writes are serialized globally: a script that fans out mutations in
      // parallel would ask the user to approve several at once, with no stable
      // order to reason about. Reads are bounded per server instead.
      if (entry.effect !== "read") {
        const run = writeQueue.chain.then(call, call);
        writeQueue.chain = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      }

      const inFlight = readSlots.get(entry.serverName) ?? 0;
      if (inFlight >= MAX_CONCURRENT_READS_PER_SERVER) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      readSlots.set(entry.serverName, inFlight + 1);
      try {
        return await call();
      } finally {
        readSlots.set(entry.serverName, (readSlots.get(entry.serverName) ?? 1) - 1);
      }
    };

    // Discovery inside an execution reads the snapshot dispatch resolves
    // against. Refreshing here would let a script describe a tool from one
    // catalog and call into another.
    const discover = (operation: string, payload: Record<string, unknown>) =>
      Promise.resolve(this.discover(operation, payload, snapshot));

    const result = await this.sandboxExecutor({
      code,
      aliases,
      dispatch,
      discover,
      ...(signal !== undefined ? { signal } : {}),
      ...(this.options.memoryLimit !== undefined ? { memoryLimit: this.options.memoryLimit } : {}),
      ...(this.options.timeoutMs !== undefined ? { timeoutMs: this.options.timeoutMs } : {}),
    });

    return { ...result, provenance: summarizeProvenance(readServers, attemptedWrite) };
  }
}

const TRUST_ORDER: readonly ServerTrust[] = ["untrusted", "reviewed", "managed"];

function summarizeProvenance(
  readServers: ReadonlyMap<string, ServerTrust>,
  attemptedWrite: boolean,
): RunProvenance {
  let lowest: ServerTrust = "managed";
  for (const trust of readServers.values()) {
    if (TRUST_ORDER.indexOf(trust) < TRUST_ORDER.indexOf(lowest)) lowest = trust;
  }
  return {
    readServers: [...readServers.keys()].sort((left, right) => (left < right ? -1 : 1)),
    lowestTrust: readServers.size === 0 ? "none" : lowest,
    attemptedWrite,
  };
}

function readOptions(payload: Record<string, unknown>) {
  return {
    ...(typeof payload.namespace === "string" ? { namespace: payload.namespace } : {}),
    ...(typeof payload.server === "string" ? { server: payload.server } : {}),
    ...(typeof payload.effect === "string" ? { effect: payload.effect } : {}),
    ...(typeof payload.limit === "number" ? { limit: payload.limit } : {}),
    ...(typeof payload.cursor === "string" ? { cursor: payload.cursor } : {}),
  };
}

function cancelled(): CodeModeDispatchError {
  return new CodeModeDispatchError({
    error: CODE_MODE_ERRORS.CANCELLED,
    message: "Execution was cancelled before this tool call started.",
  });
}

/**
 * Translate a policy denial into Code Mode's structured dispatch error.
 *
 * Failures stay failures: nothing here converts a denial into a text result
 * that a model could mistake for success. A declined approval is the
 * interesting case — the error names the annotations that made the call ask
 * for confirmation, rather than implying the tool was never reachable.
 */
function toCodeModeDispatchError(error: unknown, entry: CatalogEntry): unknown {
  if (!(error instanceof McpPolicyError)) return error;

  const approvalRefused =
    error.reason === "approval_declined" || error.reason === "approval_unavailable";
  return new CodeModeDispatchError({
    error: error.reason,
    message: error.message,
    alternatives: [...error.alternatives],
    toolName: entry.toolName,
    ...(approvalRefused ? { reason: formatApprovalReasons(entry.entry) } : {}),
  } satisfies CodeModeErrorDetails);
}

function formatApprovalReasons(codeModeTool: CodeModeTool): string {
  return codeModeTool.approvalReasons
    .map((reason) =>
      reason === "destructive_hint"
        ? "annotations.destructiveHint is true"
        : "annotations.readOnlyHint is not true",
    )
    .join("; ");
}
}
