import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ExtensionAPI, ExtensionContext } from "@sammorrowdrums/mcpi";
import { describe, expect, it, vi } from "vitest";
import { CodeModeManager } from "../code-mode/index.js";
import type { ExecuteResult, SandboxRequest } from "../code-mode/executor.js";
import { adaptTerminalCallToolResult } from "./call-tool-result.js";
import type { McpClientManager, McpTool } from "./client-manager.js";
import { McpiHostApproval } from "./host-approval.js";
import {
  McpPolicy,
  type McpApprovalPrompt,
  type McpApprovalRequest,
  type McpAuditRecord,
} from "./policy.js";
import { registerMcpToolProxies } from "../skills/mcp-tool-proxy.js";
import { createPolicyToolProvider } from "../tool-cli/provider.js";

type ConfirmOptions = Parameters<ExtensionContext["ui"]["confirm"]>[2];

interface PendingPrompt {
  readonly signal: AbortSignal | undefined;
  readonly resolve: (value: boolean) => void;
  onAbort: () => void;
}

class ReplacingConfirmUi {
  readonly prompts: { title: string; message: string }[] = [];
  maxConcurrency = 0;

  private active: PendingPrompt | undefined;
  private inFlight = 0;

  readonly confirm = (title: string, message: string, options?: ConfirmOptions): Promise<boolean> =>
    new Promise((resolve) => {
      const pending: PendingPrompt = {
        signal: options?.signal,
        resolve,
        onAbort: () => undefined,
      };
      pending.onAbort = () => this.finish(pending, false);

      this.prompts.push({ title, message });
      this.inFlight += 1;
      this.maxConcurrency = Math.max(this.maxConcurrency, this.inFlight);

      // Matches mcpi's selector replacement behavior: the previous component
      // is disposed, but its unresolved Promise remains pending.
      this.active = pending;
      pending.signal?.addEventListener("abort", pending.onAbort, { once: true });
      if (pending.signal?.aborted) pending.onAbort();
    });

  answer(value: boolean): void {
    if (!this.active) throw new Error("No active confirmation prompt");
    this.finish(this.active, value);
  }

  private finish(pending: PendingPrompt, value: boolean): void {
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if (this.active === pending) this.active = undefined;
    this.inFlight -= 1;
    pending.resolve(value);
  }
}

class PassThroughApproval implements McpApprovalPrompt {
  constructor(private readonly ui: ReplacingConfirmUi) {}

  confirm(request: McpApprovalRequest): Promise<boolean | undefined> {
    return this.ui.confirm(
      request.title,
      request.message,
      request.signal ? { signal: request.signal } : undefined,
    );
  }
}

describe("McpiHostApproval", () => {
  it("serializes confirmations in strict FIFO order, including reentrant arrivals", async () => {
    const ui = new ReplacingConfirmUi();
    const approvals = connectedApproval(ui);

    const first = approvals.confirm(approvalRequest("first"));
    const second = approvals.confirm(approvalRequest("second"));
    const third = approvals.confirm(approvalRequest("third"));

    await waitForPromptCount(ui, 1);
    expect(ui.prompts.map((prompt) => prompt.title)).toEqual(["Run first?"]);

    ui.answer(true);
    const fourth = approvals.confirm(approvalRequest("fourth"));

    await waitForPromptCount(ui, 2);
    expect(ui.prompts.map((prompt) => prompt.title)).toEqual(["Run first?", "Run second?"]);
    ui.answer(false);

    await waitForPromptCount(ui, 3);
    ui.answer(true);
    await waitForPromptCount(ui, 4);
    ui.answer(true);

    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
      true,
      false,
      true,
      true,
    ]);
    expect(ui.maxConcurrency).toBe(1);
  });

  it("settles aborted requests without prompting or leaking their listeners", async () => {
    const ui = new ReplacingConfirmUi();
    const approvals = connectedApproval(ui);
    const alreadyAborted = new AbortController();
    alreadyAborted.abort();

    await expect(
      approvals.confirm(approvalRequest("already-aborted", "proxy", alreadyAborted.signal)),
    ).resolves.toBeUndefined();
    expect(ui.prompts).toEqual([]);

    const waitingController = new AbortController();
    const addListener = vi.spyOn(waitingController.signal, "addEventListener");
    const removeListener = vi.spyOn(waitingController.signal, "removeEventListener");

    const active = approvals.confirm(approvalRequest("active"));
    const waiting = approvals.confirm(
      approvalRequest("waiting", "code-mode", waitingController.signal),
    );
    const last = approvals.confirm(approvalRequest("last", "tool-cli"));

    await waitForPromptCount(ui, 1);
    waitingController.abort();
    await expect(waiting).resolves.toBeUndefined();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);

    ui.answer(true);
    await waitForPromptCount(ui, 2);
    expect(ui.prompts.map((prompt) => prompt.title)).toEqual(["Run active?", "Run last?"]);
    const activeLast = last.then((value) => value);
    expect(await active).toBe(true);
    ui.answer(false);
    await expect(activeLast).resolves.toBe(false);
    expect(ui.maxConcurrency).toBe(1);
  });

  it("returns undefined when the active request is aborted", async () => {
    const ui = new ReplacingConfirmUi();
    const approvals = connectedApproval(ui);
    const controller = new AbortController();
    const result = approvals.confirm(approvalRequest("active", "proxy", controller.signal));

    await waitForPromptCount(ui, 1);
    controller.abort();

    await expect(result).resolves.toBeUndefined();
    expect(ui.maxConcurrency).toBe(1);
  });

  it("fails closed across context changes and resumes only for new requests", async () => {
    const oldUi = new ReplacingConfirmUi();
    const approvals = connectedApproval(oldUi);
    const active = approvals.confirm(approvalRequest("old-active"));
    const waiting = approvals.confirm(approvalRequest("old-waiting"));

    await waitForPromptCount(oldUi, 1);
    approvals.setContext(undefined);

    await expect(Promise.all([active, waiting])).resolves.toEqual([undefined, undefined]);
    await expect(approvals.confirm(approvalRequest("no-context"))).resolves.toBeUndefined();
    expect(oldUi.prompts.map((prompt) => prompt.title)).toEqual(["Run old-active?"]);

    const newUi = new ReplacingConfirmUi();
    approvals.setContext(interactiveContext(newUi));
    const fresh = approvals.confirm(approvalRequest("new"));
    await waitForPromptCount(newUi, 1);
    newUi.answer(true);
    await expect(fresh).resolves.toBe(true);
  });

  it("continues after a synchronous UI failure", async () => {
    const titles: string[] = [];
    const approvals = new McpiHostApproval();
    approvals.setContext({
      hasUI: true,
      ui: {
        confirm: (title: string) => {
          titles.push(title);
          if (titles.length === 1) throw new Error("selector unavailable");
          return Promise.resolve(true);
        },
      } as unknown as ExtensionContext["ui"],
    });

    await expect(
      Promise.all([
        approvals.confirm(approvalRequest("broken")),
        approvals.confirm(approvalRequest("next")),
      ]),
    ).resolves.toEqual([undefined, true]);
    expect(titles).toEqual(["Run broken?", "Run next?"]);
  });

  it("demonstrates the pass-through mutation overlaps and strands replaced prompts", async () => {
    const ui = new ReplacingConfirmUi();
    const approvals = new PassThroughApproval(ui);
    const controllers = [new AbortController(), new AbortController(), new AbortController()];
    const requests = controllers.map((controller, index) =>
      approvals.confirm(approvalRequest(`mutant-${String(index + 1)}`, "proxy", controller.signal)),
    );

    expect(ui.prompts).toHaveLength(3);
    expect(ui.maxConcurrency).toBe(3);

    let settled = false;
    const batch = Promise.all(requests).then(() => {
      settled = true;
    });
    ui.answer(true);
    await flushMicrotasks();
    expect(settled).toBe(false);

    controllers[0]?.abort();
    controllers[1]?.abort();
    await batch;
  });
});

describe("concurrent shared-policy approvals", () => {
  it("approves direct proxy, Code Mode, and tool-cli calls one at a time", async () => {
    const fixture = createSurfaceFixture();

    const calls = await startSurfaceCalls(fixture);
    const settled = Promise.all([calls.direct, calls.codeMode, calls.toolCli]);

    await waitForPromptCount(fixture.ui, 1);
    fixture.ui.answer(true);
    await waitForPromptCount(fixture.ui, 2);
    fixture.ui.answer(true);
    await waitForPromptCount(fixture.ui, 3);
    fixture.ui.answer(true);
    await settled;

    expect(fixture.ui.maxConcurrency).toBe(1);
    expect(fixture.ui.prompts.map((prompt) => prompt.title)).toEqual([
      'Run MCP tool "write_direct"?',
      'Run MCP tool "write_code"?',
      'Run MCP tool "write_cli"?',
    ]);
    expect(fixture.ui.prompts.map((prompt) => prompt.message)).toEqual([
      expect.stringContaining("Requested by: proxy"),
      expect.stringContaining("Requested by: code-mode"),
      expect.stringContaining("Requested by: tool-cli"),
    ]);
    expect(fixture.dispatch).toHaveBeenCalledTimes(3);
    expect(fixture.dispatch.mock.calls.map((call) => call[1])).toEqual([
      "write_direct",
      "write_code",
      "write_cli",
    ]);
    expectToolAudits(fixture.policy.getAuditLog(), {
      proxy: { decision: "allowed", approval: "granted" },
      "code-mode": { decision: "allowed", approval: "granted" },
      "tool-cli": { decision: "allowed", approval: "granted" },
    });
  });

  it("isolates approval, denial, and queued cancellation to their own calls", async () => {
    const fixture = createSurfaceFixture();
    const toolCliAbort = new AbortController();
    const calls = await startSurfaceCalls(fixture, toolCliAbort.signal);
    const settled = Promise.allSettled([calls.direct, calls.codeMode, calls.toolCli]);

    await waitForPromptCount(fixture.ui, 1);
    toolCliAbort.abort();
    fixture.ui.answer(true);
    await waitForPromptCount(fixture.ui, 2);
    fixture.ui.answer(false);

    expect((await settled).map((result) => result.status)).toEqual([
      "fulfilled",
      "rejected",
      "rejected",
    ]);
    expect(fixture.ui.maxConcurrency).toBe(1);
    expect(fixture.ui.prompts.map((prompt) => prompt.title)).toEqual([
      'Run MCP tool "write_direct"?',
      'Run MCP tool "write_code"?',
    ]);
    expect(fixture.dispatch).toHaveBeenCalledTimes(1);
    expect(fixture.dispatch.mock.calls[0]?.[1]).toBe("write_direct");
    expectToolAudits(fixture.policy.getAuditLog(), {
      proxy: { decision: "allowed", approval: "granted" },
      "code-mode": { decision: "denied", approval: "declined" },
      "tool-cli": { decision: "denied", reason: "cancelled" },
    });
  });
});

function connectedApproval(ui: ReplacingConfirmUi): McpiHostApproval {
  const approvals = new McpiHostApproval();
  approvals.setContext(interactiveContext(ui));
  return approvals;
}

function interactiveContext(ui: ReplacingConfirmUi): Pick<ExtensionContext, "hasUI" | "ui"> {
  return {
    hasUI: true,
    ui: ui as unknown as ExtensionContext["ui"],
  };
}

function approvalRequest(
  name: string,
  source: McpApprovalRequest["source"] = "proxy",
  signal?: AbortSignal,
): McpApprovalRequest {
  return {
    kind: "tool-call",
    source,
    serverName: "fixture",
    toolName: name,
    title: `Run ${name}?`,
    message: `Request ${name}`,
    ...(signal ? { signal } : {}),
  };
}

async function waitForPromptCount(ui: ReplacingConfirmUi, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && ui.prompts.length < count; attempt += 1) {
    await Promise.resolve();
  }
  expect(ui.prompts).toHaveLength(count);
}

async function flushMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await Promise.resolve();
  }
}

const SERVER_NAME = "fixture";
const EMPTY_INPUT = {
  type: "object" as const,
  properties: {
    surface: { type: "string" as const },
  },
  required: ["surface"],
  additionalProperties: false,
};

interface RegisteredProxy {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

interface SurfaceFixture {
  readonly ui: ReplacingConfirmUi;
  readonly policy: McpPolicy;
  readonly dispatch: ReturnType<typeof vi.fn>;
  readonly proxy: RegisteredProxy;
  readonly codeMode: CodeModeManager;
  readonly provider: ReturnType<typeof createPolicyToolProvider>;
}

function createSurfaceFixture(): SurfaceFixture {
  const tools = ["write_direct", "write_code", "write_cli"].map((name): McpTool => ({
    name,
    serverName: SERVER_NAME,
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: false, destructiveHint: false },
  }));
  const result: CallToolResult = { content: [{ type: "text", text: "written" }] };
  const dispatch = vi.fn(
    (
      _serverName: string,
      _toolName: string,
      _args: Record<string, unknown>,
      _signal?: AbortSignal,
    ) => Promise.resolve(adaptTerminalCallToolResult(result)),
  );
  const manager = {
    getTools: () => tools,
    getConnectedServers: () => [SERVER_NAME],
    getToolsForServer: (serverName: string) => (serverName === SERVER_NAME ? tools : []),
    callTool: dispatch,
    listResources: async () => [],
    listResourceTemplates: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClientManager;

  const ui = new ReplacingConfirmUi();
  const approvals = connectedApproval(ui);
  const policy = new McpPolicy({ gateway: manager, approvals });
  const registered: RegisteredProxy[] = [];
  const pi = {
    getAllTools: () => [],
    registerTool: (proxy: RegisteredProxy) => registered.push(proxy),
  } as unknown as ExtensionAPI;
  registerMcpToolProxies(["write_direct"], manager, policy, pi);

  const codeMode = new CodeModeManager({
    sandboxExecutor: async (request: SandboxRequest): Promise<ExecuteResult> => ({
      result: await request.dispatch(
        { kind: "identity", serverName: SERVER_NAME, toolName: "write_code" },
        { surface: "code-mode" },
      ),
      logs: [],
    }),
  });
  codeMode.initialize(manager, policy);

  const proxy = registered[0];
  if (!proxy) throw new Error("Direct proxy fixture was not registered");

  return {
    ui,
    policy,
    dispatch,
    proxy,
    codeMode,
    provider: createPolicyToolProvider(policy),
  };
}

async function startSurfaceCalls(fixture: SurfaceFixture, toolCliSignal?: AbortSignal) {
  const direct = fixture.proxy.execute("direct-call", { surface: "proxy" });
  const codeMode = fixture.codeMode.executeCode("return write_code");

  // Code Mode resolves its captured catalog before reaching the shared policy.
  // Let it enqueue while the direct prompt remains active, then add tool-cli.
  await flushMicrotasks();

  return {
    direct,
    codeMode,
    toolCli: fixture.provider.callTool(
      SERVER_NAME,
      "write_cli",
      { surface: "tool-cli" },
      toolCliSignal ? { signal: toolCliSignal } : undefined,
    ),
  };
}

function expectToolAudits(
  records: readonly McpAuditRecord[],
  expected: Readonly<
    Record<
      McpApprovalRequest["source"],
      Pick<McpAuditRecord, "decision"> & Partial<Pick<McpAuditRecord, "approval" | "reason">>
    >
  >,
): void {
  const toolRecords = records.filter((record) => record.operation === "tool");
  expect(toolRecords).toHaveLength(3);

  for (const source of ["proxy", "code-mode", "tool-cli"] as const) {
    const matching = toolRecords.filter((record) => record.source === source);
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject(expected[source]);
  }
}
