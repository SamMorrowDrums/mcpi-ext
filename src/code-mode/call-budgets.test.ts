import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult } from "../mcp/call-tool-result.js";
import type { McpClientManager, McpTool } from "../mcp/index.js";
import { McpPolicy, type McpApprovalRequest, type McpAuditRecord } from "../mcp/policy.js";
import {
  MAX_CONCURRENT_READS_PER_SERVER,
  MAX_CONCURRENT_WRITES,
  MAX_READ_CALLS,
  MAX_READ_RETRIES_TOTAL,
  MAX_WRITE_CALLS,
  MAX_WRITE_RETRIES,
} from "./budgets.js";
import { CodeModeDispatchError, type ExecuteResult, type SandboxRequest } from "./executor.js";
import { CodeModeManager } from "./index.js";

describe("Code Mode per-execution call budgets", () => {
  it("admits exactly 1,024 logical reads and rejects the 1,025th before dispatch", async () => {
    const callTool = vi.fn(async () => terminal());
    const { codeMode, policy } = fixture({
      tools: [tool("read", { readOnlyHint: true })],
      callTool,
      sandboxExecutor: (request) =>
        capture(async () => {
          for (let index = 0; index <= MAX_READ_CALLS; index += 1) {
            await request.dispatch(identity("read"), { index });
          }
          return "unexpected";
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(MAX_READ_CALLS).toBe(1_024);
    expect(result.errorDetails?.error).toBe("budget_exceeded");
    expect(result.errorDetails?.message).toContain("read-call budget");
    expect(result.errorDetails?.message).toContain("1,024");
    expect(result.errorDetails?.message).toMatch(/aggregate/i);
    expect(result.errorDetails?.message).toMatch(/paginate/i);
    expect(result.errorDetails?.message).toMatch(/split.+only when/i);
    expect(result.errorDetails?.message).not.toMatch(/re-?run.+code_execute/i);
    expect(callTool).toHaveBeenCalledTimes(1_024);
    expect(policy.getAuditLog()).toHaveLength(500);
    expect(policy.getAuditLog().every((record) => record.decision === "allowed")).toBe(true);
  });

  it("admits 16 approval-gated calls across every non-read posture, then stops before prompt 17", async () => {
    let approvalConcurrency = 0;
    let maxApprovalConcurrency = 0;
    let writeConcurrency = 0;
    let maxWriteConcurrency = 0;
    const approvalOrder: string[] = [];
    const dispatchOrder: string[] = [];
    const confirm = vi.fn(async (request: McpApprovalRequest) => {
      approvalConcurrency += 1;
      maxApprovalConcurrency = Math.max(maxApprovalConcurrency, approvalConcurrency);
      await Promise.resolve();
      approvalConcurrency -= 1;
      approvalOrder.push(`${request.toolName}:${approvalIndex(request)}`);
      return true;
    });
    const callTool = vi.fn(
      async (_serverName: string, toolName: string, args: Record<string, unknown>) => {
        writeConcurrency += 1;
        maxWriteConcurrency = Math.max(maxWriteConcurrency, writeConcurrency);
        await new Promise<void>((resolve) => setImmediate(resolve));
        writeConcurrency -= 1;
        dispatchOrder.push(`${toolName}:${String(args.index)}`);
        return terminal();
      },
    );
    const names = ["write", "destructive", "contradictory"] as const;
    const { codeMode, policy } = fixture({
      tools: [
        tool("write"),
        tool("destructive", { readOnlyHint: false, destructiveHint: true }),
        tool("contradictory", { readOnlyHint: true, destructiveHint: true }),
      ],
      callTool,
      confirm,
      sandboxExecutor: (request) =>
        capture(async () => {
          const calls = Array.from({ length: MAX_WRITE_CALLS + 1 }, (_, index) =>
            request.dispatch(identity(names[index % names.length]), { index }),
          );
          const settled = await Promise.allSettled(calls);
          const seventeenth = settled[MAX_WRITE_CALLS];
          if (seventeenth.status === "rejected") throw seventeenth.reason;
          return "unexpected";
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(MAX_WRITE_CALLS).toBe(16);
    expect(MAX_CONCURRENT_WRITES).toBe(1);
    expect(result.errorDetails?.error).toBe("budget_exceeded");
    expect(result.errorDetails?.message).toContain("write-call budget");
    expect(result.errorDetails?.message).toContain("16");
    expect(result.errorDetails?.message).toMatch(/every write.+individual approval/i);
    expect(result.errorDetails?.message).toMatch(/split.+only when/i);
    expect(confirm).toHaveBeenCalledTimes(16);
    expect(callTool).toHaveBeenCalledTimes(16);
    expect(maxApprovalConcurrency).toBe(1);
    expect(maxWriteConcurrency).toBe(1);
    expect(approvalOrder).toEqual(
      Array.from({ length: 16 }, (_, index) => `${names[index % names.length]}:${String(index)}`),
    );
    expect(dispatchOrder).toEqual(approvalOrder);
    expect(policy.getAuditLog()).toHaveLength(16);
    expect(
      policy
        .getAuditLog()
        .every(
          (record) =>
            record.decision === "allowed" &&
            record.approval === "granted" &&
            record.operation === "tool",
        ),
    ).toBe(true);
  });

  it("allows 1,024 reads and 16 separately approved writes in one execution", async () => {
    const confirm = vi.fn(async () => true);
    const callTool = vi.fn(async () => terminal());
    const { codeMode } = fixture({
      tools: [tool("read", { readOnlyHint: true }), tool("write")],
      callTool,
      confirm,
      sandboxExecutor: (request) =>
        capture(async () => {
          for (let index = 0; index < MAX_READ_CALLS; index += 1) {
            await request.dispatch(identity("read"), { index });
          }
          for (let index = 0; index < MAX_WRITE_CALLS; index += 1) {
            await request.dispatch(identity("write"), { index });
          }
          return { reads: MAX_READ_CALLS, writes: MAX_WRITE_CALLS };
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ reads: 1_024, writes: 16 });
    expect(callTool).toHaveBeenCalledTimes(1_040);
    expect(confirm).toHaveBeenCalledTimes(16);
  });

  it("keeps a 1,024-read Promise.all at eight upstream calls per server", async () => {
    let concurrency = 0;
    let maxConcurrency = 0;
    const callTool = vi.fn(async () => {
      concurrency += 1;
      maxConcurrency = Math.max(maxConcurrency, concurrency);
      await new Promise<void>((resolve) => setImmediate(resolve));
      concurrency -= 1;
      return terminal();
    });
    const { codeMode } = fixture({
      tools: [tool("read", { readOnlyHint: true })],
      callTool,
      sandboxExecutor: (request) =>
        capture(async () => {
          const results = await Promise.all(
            Array.from({ length: MAX_READ_CALLS }, (_, index) =>
              request.dispatch(identity("read"), { index }),
            ),
          );
          return results.length;
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(MAX_CONCURRENT_READS_PER_SERVER).toBe(8);
    expect(result.error).toBeUndefined();
    expect(result.result).toBe(1_024);
    expect(callTool).toHaveBeenCalledTimes(1_024);
    expect(maxConcurrency).toBe(8);
  });

  it("charges declined writes so repeated denials cannot evade the write budget", async () => {
    const confirm = vi.fn(async () => false);
    const callTool = vi.fn(async () => terminal());
    const { codeMode, policy } = fixture({
      tools: [tool("write")],
      callTool,
      confirm,
      sandboxExecutor: (request) =>
        capture(async () => {
          for (let index = 0; index < MAX_WRITE_CALLS; index += 1) {
            await expectDispatchError(
              request.dispatch(identity("write"), { index }),
              "approval_declined",
            );
          }
          return request.dispatch(identity("write"), { index: MAX_WRITE_CALLS });
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.errorDetails?.error).toBe("budget_exceeded");
    expect(confirm).toHaveBeenCalledTimes(16);
    expect(callTool).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toHaveLength(16);
    expect(
      policy
        .getAuditLog()
        .every(
          (record) =>
            record.decision === "denied" &&
            record.reason === "approval_declined" &&
            record.approval === "declined",
        ),
    ).toBe(true);
  });

  it("charges known invalid calls after classification but not their approval or dispatch", async () => {
    const confirm = vi.fn(async () => true);
    const callTool = vi.fn(async () => terminal());
    const { codeMode, policy } = fixture({
      tools: [
        tool("write", undefined, {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        }),
      ],
      callTool,
      confirm,
      sandboxExecutor: (request) =>
        capture(async () => {
          for (let index = 0; index < MAX_WRITE_CALLS; index += 1) {
            await expectDispatchError(request.dispatch(identity("write"), {}), "invalid_arguments");
          }
          return request.dispatch(identity("write"), { value: "valid" });
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.errorDetails?.error).toBe("budget_exceeded");
    expect(confirm).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toHaveLength(16);
    expect(policy.getAuditLog().every(isInvalidArgumentAudit)).toBe(true);
  });

  it("does not charge an unknown target that cannot be authoritatively classified", async () => {
    const callTool = vi.fn(async () => terminal());
    const { codeMode } = fixture({
      tools: [tool("read", { readOnlyHint: true })],
      callTool,
      sandboxExecutor: (request) =>
        capture(async () => {
          await expectDispatchError(request.dispatch(identity("missing"), {}), "unknown_tool");
          for (let index = 0; index < MAX_READ_CALLS; index += 1) {
            await request.dispatch(identity("read"), { index });
          }
          return MAX_READ_CALLS;
        }),
    });

    const result = await codeMode.executeCode("return null;");

    expect(result.error).toBeUndefined();
    expect(result.result).toBe(1_024);
    expect(callTool).toHaveBeenCalledTimes(1_024);
  });

  it("cancels before budget admission without prompting, dispatching, or auditing", async () => {
    const controller = new AbortController();
    controller.abort();
    const confirm = vi.fn(async () => true);
    const callTool = vi.fn(async () => terminal());
    const { codeMode, policy } = fixture({
      tools: [tool("write")],
      callTool,
      confirm,
      sandboxExecutor: (request) => capture(() => request.dispatch(identity("write"), {})),
    });

    const result = await codeMode.executeCode("return null;", controller.signal);

    expect(result.errorDetails?.error).toBe("cancelled");
    expect(confirm).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toEqual([]);
  });

  it("records cancellation after write admission and before dispatch", async () => {
    const controller = new AbortController();
    const confirm = vi.fn(async () => {
      controller.abort();
      return undefined;
    });
    const callTool = vi.fn(async () => terminal());
    const { codeMode, policy } = fixture({
      tools: [tool("write")],
      callTool,
      confirm,
      sandboxExecutor: (request) => capture(() => request.dispatch(identity("write"), {})),
    });

    const result = await codeMode.executeCode("return null;", controller.signal);

    expect(result.errorDetails?.error).toBe("cancelled");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(callTool).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toHaveLength(1);
    expect(policy.getAuditLog()[0]).toMatchObject({
      operation: "tool",
      decision: "denied",
      reason: "cancelled",
    });
  });

  it("does not retry an ordinary non-rate transport failure", async () => {
    const callTool = vi.fn(async () => {
      throw new Error("transport failed");
    });
    const { codeMode } = fixture({
      tools: [tool("read", { readOnlyHint: true })],
      callTool,
      sandboxExecutor: async (request) => {
        try {
          await request.dispatch(identity("read"), {});
          return { result: "unexpected", logs: [] };
        } catch (error) {
          return { result: undefined, error: String(error), logs: [] };
        }
      },
    });

    const result = await codeMode.executeCode("return null;");

    expect(MAX_READ_RETRIES_TOTAL).toBe(3);
    expect(MAX_WRITE_RETRIES).toBe(0);
    expect(result.error).toContain("transport failed");
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

interface FixtureOptions {
  tools: McpTool[];
  callTool: ReturnType<typeof vi.fn>;
  sandboxExecutor: (request: SandboxRequest) => Promise<ExecuteResult>;
  confirm?: (request: McpApprovalRequest) => Promise<boolean | undefined>;
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
  const codeMode = new CodeModeManager({ sandboxExecutor: options.sandboxExecutor });
  const policy = new McpPolicy({
    gateway,
    ...(options.confirm ? { approvals: { confirm: options.confirm } } : {}),
  });
  codeMode.initialize(gateway, policy);
  return { codeMode, policy };
}

function tool(
  name: string,
  annotations?: McpTool["annotations"],
  inputSchema: McpTool["inputSchema"] = { type: "object", properties: {} },
): McpTool {
  return {
    name,
    inputSchema,
    serverName: "fixture",
    ...(annotations ? { annotations } : {}),
  };
}

function identity(toolName: string) {
  return { kind: "identity", serverName: "fixture", toolName } as const;
}

function terminal() {
  const result: CallToolResult = { content: [] };
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

async function expectDispatchError(operation: Promise<unknown>, expected: string): Promise<void> {
  try {
    await operation;
  } catch (error) {
    if (!(error instanceof CodeModeDispatchError)) throw error;
    expect(error.details.error).toBe(expected);
    return;
  }
  throw new Error(`Expected ${expected}`);
}

function approvalIndex(request: McpApprovalRequest): string {
  const match = /"index": (\d+)/.exec(request.message);
  if (!match) throw new Error(`Approval did not include an index:\n${request.message}`);
  return match[1];
}

function isInvalidArgumentAudit(record: McpAuditRecord): boolean {
  return (
    record.operation === "tool" &&
    record.decision === "denied" &&
    record.reason === "invalid_arguments" &&
    record.approval === undefined
  );
}
