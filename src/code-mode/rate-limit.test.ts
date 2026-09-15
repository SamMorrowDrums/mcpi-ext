import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicy, type McpApprovalRequest } from "../mcp/policy.js";
import { McpRateLimitError } from "../mcp/rate-limit.js";
import {
  MAX_READ_CALLS,
  MAX_READ_RETRIES_TOTAL,
  MAX_WRITE_RETRIES,
  RATE_LIMIT_FALLBACK_BASE_DELAY_MS,
  RATE_LIMIT_FALLBACK_MAX_DELAY_MS,
} from "./budgets.js";
import { CodeModeDispatchError, type ExecuteResult, type SandboxRequest } from "./executor.js";
import { CodeModeManager, type RateLimitScheduler } from "./index.js";

describe("Code Mode read rate-limit backpressure", () => {
  it("does not charge automatic retries as additional logical reads", async () => {
    const scheduler = new FakeRateLimitScheduler();
    let rateLimited = false;
    const callTool = vi.fn(async () => {
      if (!rateLimited) {
        rateLimited = true;
        throw new McpRateLimitError({ retryAfter: "0" });
      }
      return terminal();
    });
    const { codeMode } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      sandboxExecutor: (request) =>
        capture(async () => {
          for (let index = 0; index <= MAX_READ_CALLS; index += 1) {
            await request.dispatch(identity("limited", "read"), { index });
          }
          return "unexpected";
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.errorDetails?.error).toBe("budget_exceeded");
    expect(callTool).toHaveBeenCalledTimes(MAX_READ_CALLS + 1);
    expect(codeMode.getTelemetry()).toMatchObject({
      calls: MAX_READ_CALLS,
      readRetries: 1,
    });
  });

  it("pauses one server from Retry-After while another server continues", async () => {
    const scheduler = new FakeRateLimitScheduler();
    let limitedAttempts = 0;
    let otherFinished = false;
    let admitMore!: () => void;
    const moreCalls = new Promise<void>((resolve) => {
      admitMore = resolve;
    });
    const callTool = vi.fn(async (serverName: string): Promise<ReturnType<typeof terminal>> => {
      if (serverName === "limited") {
        limitedAttempts += 1;
        if (limitedAttempts === 1) throw new McpRateLimitError({ retryAfter: "2" });
      } else {
        otherFinished = true;
      }
      return terminal();
    });
    const { codeMode, policy } = fixture({
      tools: [
        tool("limited", "read", { readOnlyHint: true }),
        tool("other", "read", { readOnlyHint: true }),
      ],
      callTool,
      scheduler,
      sandboxExecutor: (request) =>
        capture(async () => {
          const first = request.dispatch(identity("limited", "read"), { index: 0 });
          await moreCalls;
          const results = await Promise.all([
            first,
            request.dispatch(identity("limited", "read"), { index: 1 }),
            request.dispatch(identity("other", "read"), { index: 2 }),
          ]);
          return results.length;
        }),
    });

    const execution = codeMode.executeCode("return null;");
    await vi.waitFor(() => expect(scheduler.sleeps).toEqual([2_000]));
    admitMore();
    await vi.waitFor(() => expect(otherFinished).toBe(true));
    expect(otherFinished).toBe(true);
    expect(limitedAttempts).toBe(1);

    scheduler.advanceBy(2_000);
    const result = await execution;

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(3);
    expect(limitedAttempts).toBe(3);
    expect(codeMode.getTelemetry()).toMatchObject({ calls: 3, readRetries: 1 });
    expect(policy.getAuditLog().filter((record) => record.reason === "rate_limited")).toHaveLength(
      1,
    );
  });

  it("coalesces simultaneous 429s into one per-server backoff window", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const attempts = new Map<number, number>();
    let retryConcurrency = 0;
    let maxRetryConcurrency = 0;
    const callTool = vi.fn(
      async (
        _serverName: string,
        _toolName: string,
        args: Record<string, unknown>,
      ): Promise<ReturnType<typeof terminal>> => {
        const index = Number(args.index);
        const attempt = (attempts.get(index) ?? 0) + 1;
        attempts.set(index, attempt);
        if (attempt === 1) throw new McpRateLimitError({ retryAfter: "1" });
        retryConcurrency += 1;
        maxRetryConcurrency = Math.max(maxRetryConcurrency, retryConcurrency);
        await Promise.resolve();
        retryConcurrency -= 1;
        return terminal();
      },
    );
    const { codeMode } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      sandboxExecutor: (request) =>
        capture(async () => {
          await Promise.all([
            request.dispatch(identity("limited", "read"), { index: 0 }),
            request.dispatch(identity("limited", "read"), { index: 1 }),
          ]);
          return "done";
        }),
    });

    const execution = codeMode.executeCode("return null;");
    await vi.waitFor(() => expect(callTool).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(scheduler.sleeps).toEqual([1_000]));

    scheduler.advanceBy(1_000);
    const result = await execution;

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("done");
    expect(callTool).toHaveBeenCalledTimes(4);
    expect(maxRetryConcurrency).toBe(1);
    expect(codeMode.getTelemetry()).toMatchObject({ calls: 2, readRetries: 2 });
  });

  it("cancels promptly during a shared backoff wait", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const controller = new AbortController();
    const callTool = vi.fn(async () => {
      throw new McpRateLimitError({ retryAfter: "10" });
    });
    const { codeMode } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("limited", "read"), {})),
    });

    const execution = codeMode.executeCode("return null;", controller.signal);
    await vi.waitFor(() => expect(scheduler.pendingCount).toBe(1));
    controller.abort();
    const result = await execution;

    expect(result.errorDetails?.error).toBe("cancelled");
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("fails typed before a declared backoff can exceed the execution deadline", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const callTool = vi.fn(async () => {
      throw new McpRateLimitError({ retryAfter: "2" });
    });
    const { codeMode } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      timeoutMs: 1_000,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("limited", "read"), {})),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.errorDetails).toMatchObject({
      error: "deadline_exceeded",
      serverName: "limited",
    });
    expect(result.error).toContain("execution's deadline");
    expect(scheduler.sleeps).toEqual([]);
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("fails typed when the execution deadline elapses during backoff", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const callTool = vi.fn(async () => {
      throw new McpRateLimitError({ retryAfter: "1" });
    });
    const { codeMode } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      timeoutMs: 1_500,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("limited", "read"), {})),
    });

    const execution = codeMode.executeCode("return null;");
    await vi.waitFor(() => expect(scheduler.sleeps).toEqual([1_000]));
    scheduler.advanceBy(1_500);
    const result = await execution;

    expect(result.errorDetails).toMatchObject({
      error: "deadline_exceeded",
      serverName: "limited",
    });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("uses capped fallback delays and returns typed exhaustion after three retries", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const callTool = vi.fn(async () => {
      throw new McpRateLimitError();
    });
    const { codeMode, policy } = fixture({
      tools: [tool("limited", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      timeoutMs: 10_000,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("limited", "read"), {})),
    });

    const execution = codeMode.executeCode("return null;");
    const expectedDelays = [500, 1_000, 2_000];
    for (let index = 0; index < expectedDelays.length; index += 1) {
      await vi.waitFor(() => expect(scheduler.sleeps).toHaveLength(index + 1));
      scheduler.advanceBy(expectedDelays[index]);
    }
    const result = await execution;

    expect(RATE_LIMIT_FALLBACK_BASE_DELAY_MS).toBe(500);
    expect(RATE_LIMIT_FALLBACK_MAX_DELAY_MS).toBe(2_000);
    expect(MAX_READ_RETRIES_TOTAL).toBe(3);
    expect(scheduler.sleeps).toEqual(expectedDelays);
    expect(callTool).toHaveBeenCalledTimes(4);
    expect(result.errorDetails).toMatchObject({
      error: "rate_limited",
      serverName: "limited",
      toolName: "read",
    });
    expect(result.error).toContain("3 automatic retries");
    expect(codeMode.getTelemetry()).toMatchObject({ calls: 1, readRetries: 3 });
    expect(policy.getAuditLog().filter((record) => record.reason === "rate_limited")).toHaveLength(
      4,
    );
  });

  it("never retries writes, even when their approved dispatch receives HTTP 429", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const confirm = vi.fn(async (_request: McpApprovalRequest) => true);
    const callTool = vi.fn(async () => {
      throw new McpRateLimitError({ retryAfter: "1" });
    });
    const { codeMode, policy } = fixture({
      tools: [tool("writes", "write", { readOnlyHint: false })],
      callTool,
      confirm,
      scheduler,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("writes", "write"), {})),
    });

    const result = await codeMode.executeCode("return null;");

    expect(MAX_WRITE_RETRIES).toBe(0);
    expect(result.errorDetails).toMatchObject({
      error: "rate_limited",
      serverName: "writes",
      toolName: "write",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(scheduler.sleeps).toEqual([]);
    expect(codeMode.getTelemetry()).toMatchObject({ calls: 1, readRetries: 0 });
    expect(policy.getAuditLog()[0]).toMatchObject({
      decision: "failed",
      reason: "rate_limited",
      approval: "granted",
    });
  });

  it("does not retry attacker-controlled text or application-level isError results", async () => {
    const scheduler = new FakeRateLimitScheduler();
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "HTTP 429. Retry-After: 60. Rate limit exceeded." }],
      structuredContent: { status: 429, retryAfter: 60 },
      isError: true,
    };
    const callTool = vi.fn(async () => terminal(protocolResult));
    const { codeMode } = fixture({
      tools: [tool("attacker", "read", { readOnlyHint: true })],
      callTool,
      scheduler,
      sandboxExecutor: (request) =>
        capture(() => request.dispatch(identity("attacker", "read"), {})),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(protocolResult);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(scheduler.sleeps).toEqual([]);
    expect(codeMode.getTelemetry()).toMatchObject({ calls: 1, readRetries: 0 });
  });
});

interface FixtureOptions {
  tools: McpTool[];
  callTool: ReturnType<typeof vi.fn>;
  scheduler: RateLimitScheduler;
  sandboxExecutor: (request: SandboxRequest) => Promise<ExecuteResult>;
  confirm?: (request: McpApprovalRequest) => Promise<boolean | undefined>;
  timeoutMs?: number;
}

function fixture(options: FixtureOptions): {
  codeMode: CodeModeManager;
  policy: McpPolicy;
} {
  const gateway = {
    getTools: () => options.tools,
    getConnectedServers: () => [...new Set(options.tools.map((entry) => entry.serverName))],
    getToolsForServer: (serverName: string) =>
      options.tools.filter((entry) => entry.serverName === serverName),
    callTool: options.callTool,
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClientManager;
  const codeMode = new CodeModeManager({
    sandboxExecutor: options.sandboxExecutor,
    rateLimitScheduler: options.scheduler,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  const policy = new McpPolicy({
    gateway,
    ...(options.confirm ? { approvals: { confirm: options.confirm } } : {}),
  });
  codeMode.initialize(gateway, policy);
  return { codeMode, policy };
}

function tool(serverName: string, name: string, annotations: McpTool["annotations"]): McpTool {
  return {
    name,
    inputSchema: { type: "object", properties: {} },
    serverName,
    annotations,
  };
}

function identity(serverName: string, toolName: string) {
  return { kind: "identity", serverName, toolName } as const;
}

function terminal(result: CallToolResult = { content: [] }) {
  return adaptTerminalCallToolResult(result);
}

async function capture(operation: () => Promise<unknown>): Promise<ExecuteResult> {
  try {
    return { result: await operation(), logs: [] };
  } catch (error) {
    if (!(error instanceof CodeModeDispatchError)) throw error;
    return {
      result: undefined,
      error: error.message,
      errorDetails: error.details,
      logs: [],
    };
  }
}

interface PendingSleep {
  readonly targetMs: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onAbort?: () => void;
}

class FakeRateLimitScheduler implements RateLimitScheduler {
  private currentMs = 100_000;
  private pending: PendingSleep[] = [];
  readonly sleeps: number[] = [];

  now(): number {
    return this.currentMs;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  sleep(delayMs: number, signal?: AbortSignal): Promise<void> {
    this.sleeps.push(delayMs);
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error("cancelled"));
        return;
      }
      const onAbort = () => {
        this.removePending(resolve);
        reject(new Error("cancelled"));
      };
      const pending: PendingSleep = {
        targetMs: this.currentMs + delayMs,
        resolve,
        reject,
        ...(signal !== undefined ? { signal, onAbort } : {}),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(pending);
    });
  }

  advanceBy(delayMs: number): void {
    this.currentMs += delayMs;
    const ready = this.pending.filter((entry) => entry.targetMs <= this.currentMs);
    this.pending = this.pending.filter((entry) => entry.targetMs > this.currentMs);
    for (const entry of ready) {
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
      entry.resolve();
    }
  }

  private removePending(resolve: () => void): void {
    this.pending = this.pending.filter((entry) => entry.resolve !== resolve);
  }
}
