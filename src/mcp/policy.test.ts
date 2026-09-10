import type {
  ReadResourceResult,
  Resource,
  ResourceTemplateType,
} from "@modelcontextprotocol/client";
import { describe, expect, it, vi } from "vitest";
import { adaptTerminalCallToolResult, type TerminalCallToolResult } from "./call-tool-result.js";
import type { McpTool } from "./client-manager.js";
import { noSkillsExtensionGateway } from "./gateway-defaults.js";
import {
  McpPolicy,
  McpPolicyError,
  isReadOnlyToolCall,
  validateToolArguments,
  type McpApprovalRequest,
  type McpCallSource,
  type McpPolicyGateway,
  type McpPolicySkill,
} from "./policy.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OBJECT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object" as const,
  properties: { city: { type: "string" } },
  required: ["city"],
  additionalProperties: false,
};

function tool(name: string, overrides: Partial<McpTool> = {}): McpTool {
  return {
    name,
    serverName: "alpha",
    inputSchema: OBJECT_SCHEMA,
    ...overrides,
  };
}

const readOnlyTool = tool("read_weather", {
  annotations: { readOnlyHint: true, destructiveHint: false },
});
const writeTool = tool("send_alert", {
  annotations: { readOnlyHint: false, destructiveHint: true },
});
const unannotatedTool = tool("lookup_city");
const gatedTool = tool("secret_probe", {
  annotations: { readOnlyHint: true, destructiveHint: false },
});

const PROTOCOL_RESULT = {
  content: [{ type: "text" as const, text: "sunny" }],
  structuredContent: { temp: 21 },
};

interface Harness {
  policy: McpPolicy;
  gateway: {
    callTool: ReturnType<typeof vi.fn>;
    listResources: ReturnType<typeof vi.fn>;
    listResourceTemplates: ReturnType<typeof vi.fn>;
    readResource: ReturnType<typeof vi.fn>;
  };
  confirm: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    tools?: Record<string, McpTool[]>;
    servers?: string[];
    approval?: boolean | undefined;
    resources?: Record<string, Resource[]>;
    resourceTemplates?: Record<string, ResourceTemplateType[]>;
    resourceBody?: string;
  } = {},
): Harness {
  const toolsByServer = options.tools ?? {
    alpha: [readOnlyTool, writeTool, unannotatedTool],
  };
  const servers = options.servers ?? Object.keys(toolsByServer);

  const callTool = vi
    .fn<(...args: unknown[]) => Promise<TerminalCallToolResult>>()
    .mockResolvedValue(adaptTerminalCallToolResult(PROTOCOL_RESULT));
  const listResources = vi
    .fn<(server: string) => Promise<Resource[]>>()
    .mockImplementation((server: string) => Promise.resolve(options.resources?.[server] ?? []));
  const listResourceTemplates = vi
    .fn<(server: string) => Promise<ResourceTemplateType[]>>()
    .mockImplementation((server: string) =>
      Promise.resolve(options.resourceTemplates?.[server] ?? []),
    );
  const readResource = vi
    .fn<(...args: unknown[]) => Promise<ReadResourceResult>>()
    .mockImplementation((_server: unknown, uri: unknown) =>
      Promise.resolve({
        contents: [{ uri: String(uri), text: options.resourceBody ?? "body" }],
      }),
    );

  const gateway: McpPolicyGateway = {
    ...noSkillsExtensionGateway,
    getConnectedServers: () => [...servers],
    getToolsForServer: (name) => toolsByServer[name] ?? [],
    callTool: callTool as unknown as McpPolicyGateway["callTool"],
    listResources: listResources as unknown as McpPolicyGateway["listResources"],
    listResourceTemplates:
      listResourceTemplates as unknown as McpPolicyGateway["listResourceTemplates"],
    readResource: readResource as unknown as McpPolicyGateway["readResource"],
  };

  const confirm = vi.fn<(request: McpApprovalRequest) => Promise<boolean | undefined>>();
  confirm.mockResolvedValue(options.approval);

  const policy = new McpPolicy({
    gateway,
    ...("approval" in options ? { approvals: { confirm } } : {}),
  });

  return {
    policy,
    gateway: { callTool, listResources, listResourceTemplates, readResource },
    confirm,
  };
}

async function expectDenied(promise: Promise<unknown>, reason: string): Promise<McpPolicyError> {
  const error = await promise.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(error).toBeInstanceOf(McpPolicyError);
  const policyError = error as McpPolicyError;
  expect(policyError.reason).toBe(reason);
  return policyError;
}

const ALL_SOURCES: McpCallSource[] = ["proxy", "code-mode", "tool-cli"];

// ---------------------------------------------------------------------------
// One dispatcher, crossed exactly once
// ---------------------------------------------------------------------------

describe("single dispatch boundary", () => {
  it.each(ALL_SOURCES)(
    "routes a %s read-only call through the gateway exactly once",
    async (source) => {
      const { policy, gateway } = harness({ approval: true });

      const result = await policy.callTool({
        source,
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: "lisbon" },
      });

      expect(gateway.callTool).toHaveBeenCalledTimes(1);
      expect(result).toEqual(adaptTerminalCallToolResult(PROTOCOL_RESULT));

      const audit = policy.getAuditLog();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        source,
        operation: "tool",
        serverName: "alpha",
        toolName: "read_weather",
        decision: "allowed",
      });
    },
  );

  it("produces identical successful terminal results for every path", async () => {
    const results: TerminalCallToolResult[] = [];
    for (const source of ALL_SOURCES) {
      const { policy } = harness({ approval: true });
      results.push(
        await policy.callTool({
          source,
          serverName: "alpha",
          toolName: "read_weather",
          args: { city: "lisbon" },
        }),
      );
    }

    expect(results[0]).toEqual(results[1]);
    expect(results[1]).toEqual(results[2]);
    expect(results[0].kind).toBe("terminal");
    expect(results[0].result).toEqual(PROTOCOL_RESULT);
  });

  it("records exactly one audit entry per denial too", async () => {
    const { policy, gateway } = harness();

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "no_such_tool",
        args: {},
      }),
      "tool_not_discovered",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
    expect(policy.getAuditLog()).toHaveLength(1);
    expect(policy.getAuditLog()[0]).toMatchObject({
      decision: "denied",
      reason: "tool_not_discovered",
    });
  });
});

// ---------------------------------------------------------------------------
// Unknown / undiscovered tools never reach upstream
// ---------------------------------------------------------------------------

describe("unknown and undiscovered tools", () => {
  it.each(ALL_SOURCES)(
    "refuses an undiscovered tool from %s before any provider call",
    async (source) => {
      const { policy, gateway } = harness({ approval: true });

      await expectDenied(
        policy.callTool({
          source,
          serverName: "alpha",
          toolName: "ghost_tool",
          args: {},
        }),
        "tool_not_discovered",
      );

      expect(gateway.callTool).not.toHaveBeenCalled();
    },
  );

  it("refuses a disconnected server before any provider call", async () => {
    const { policy, gateway } = harness({ approval: true });

    await expectDenied(
      policy.callTool({
        source: "tool-cli",
        serverName: "nowhere",
        toolName: "read_weather",
        args: { city: "lisbon" },
      }),
      "server_not_connected",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("refuses a tool that belongs to a different server", async () => {
    const { policy, gateway } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool], beta: [tool("beta_only")] },
    });

    await expectDenied(
      policy.callTool({
        source: "tool-cli",
        serverName: "alpha",
        toolName: "beta_only",
        args: {},
      }),
      "tool_not_discovered",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Schema validation
// ---------------------------------------------------------------------------

describe("argument validation", () => {
  it("rejects a call missing a required property before dispatch", async () => {
    const { policy, gateway } = harness({ approval: true });

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "read_weather",
        args: {},
      }),
      "invalid_arguments",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("rejects undeclared properties when additionalProperties is false", async () => {
    const { policy, gateway } = harness({ approval: true });

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: "lisbon", sneaky: true },
      }),
      "invalid_arguments",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("rejects a wrongly typed property", async () => {
    const { policy } = harness({ approval: true });

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: 42 },
      }),
      "invalid_arguments",
    );
  });

  it("validateToolArguments accepts allOf-declared requirements", () => {
    const schema = {
      type: "object" as const,
      allOf: [{ required: ["id"] }],
    };
    expect(validateToolArguments(schema, { id: "x" })).toBeUndefined();
    expect(validateToolArguments(schema, {})).toBeTypeOf("string");
  });

  it("validateToolArguments passes unknown schema shapes through", () => {
    const schema = { $ref: "#/$defs/thing" } as unknown as McpTool["inputSchema"];
    expect(validateToolArguments(schema, { anything: 1 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Deferral is exposure, not authorization
// ---------------------------------------------------------------------------

describe("deferral and discovery visibility", () => {
  const skill: McpPolicySkill = {
    name: "probe",
    uri: "skill://probe/SKILL.md",
    serverName: "alpha",
    referencedTools: ["secret_probe"],
  };

  it("keeps every discovered tool discoverable while marking the definition deferred", () => {
    const { policy } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool, gatedTool] },
    });
    policy.registerSkills([skill]);

    // Discovery is not the skills' to filter: Code Mode and tool-cli both read
    // this set, and neither should need a skill loaded to see a tool exists.
    const discoverable = policy.getDiscoverableTools("alpha").map((t) => t.name);
    expect(discoverable).toEqual(["read_weather", "secret_probe"]);

    // The direct proxy definition is still deferred. That is a statement about
    // which schema the prompt carries, and nothing else.
    expect(policy.isDeferred("secret_probe")).toBe(true);
    expect(policy.getReferencingSkills("secret_probe")).toEqual(["probe"]);
  });

  it.each(ALL_SOURCES)(
    "dispatches a deferred tool from the %s path with no skill loaded",
    async (source) => {
      const { policy, gateway } = harness({
        approval: true,
        tools: { alpha: [gatedTool] },
      });
      policy.registerSkills([skill]);

      await policy.callTool({
        source,
        serverName: "alpha",
        toolName: "secret_probe",
        args: { city: "lisbon" },
      });

      expect(gateway.callTool).toHaveBeenCalledTimes(1);
    },
  );

  it("reports deferred names without removing them from discovery", () => {
    const { policy } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool, gatedTool] },
    });
    policy.registerSkills([skill]);

    expect(policy.getDeferredToolNames()).toEqual(["secret_probe"]);
    expect(policy.getVisibleServers()).toEqual(["alpha"]);
    expect(policy.getDiscoverableTools("alpha")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Skill references activate exposure, and ask nothing
// ---------------------------------------------------------------------------

describe("skill reference activation", () => {
  const skill: McpPolicySkill = {
    name: "probe",
    uri: "skill://probe/SKILL.md",
    serverName: "alpha",
    referencedTools: ["secret_probe"],
  };

  function referenceHarness() {
    const h = harness({ approval: true, tools: { alpha: [gatedTool] } });
    h.policy.registerSkills([skill]);
    return h;
  }

  it("reveals the referenced definitions without prompting", () => {
    const { policy, confirm } = referenceHarness();

    expect(policy.isDeferred("secret_probe")).toBe(true);
    const outcome = policy.activateSkillReference(skill);

    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.status).toBe("activated");
    expect(outcome.referencedTools).toEqual(["secret_probe"]);
    expect(policy.isDeferred("secret_probe")).toBe(false);
  });

  it("records the activation as an allowed skill-reference crossing", () => {
    const { policy } = referenceHarness();

    policy.activateSkillReference(skill);

    expect(policy.getAuditLog().at(-1)).toMatchObject({
      source: "skill-load",
      operation: "skill-reference",
      serverName: "alpha",
      uri: "skill://probe/SKILL.md",
      decision: "allowed",
    });
  });

  it("reports a repeat activation without prompting or re-revealing", () => {
    const { policy, confirm } = referenceHarness();

    expect(policy.activateSkillReference(skill).status).toBe("activated");
    expect(policy.activateSkillReference(skill).status).toBe("reactivated");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("treats a widened reference set as a fresh activation", () => {
    const h = harness({
      approval: true,
      tools: { alpha: [gatedTool, writeTool] },
    });
    h.policy.registerSkills([skill]);
    h.policy.activateSkillReference(skill);

    const widened: McpPolicySkill = { ...skill, referencedTools: ["secret_probe", "send_alert"] };
    const outcome = h.policy.activateSkillReference(widened);

    expect(outcome.status).toBe("activated");
    expect(outcome.referencedTools).toEqual(["secret_probe", "send_alert"]);
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it("keeps activation bound to the origin that advertised the skill", () => {
    const h = harness({
      approval: true,
      tools: { alpha: [gatedTool], beta: [gatedTool] },
    });
    h.policy.registerSkills([skill]);
    h.policy.activateSkillReference(skill);

    const fromBeta = h.policy.activateSkillReference({ ...skill, serverName: "beta" });

    expect(fromBeta.status).toBe("activated");
    expect(h.policy.getAuditLog().at(-1)).toMatchObject({
      operation: "skill-reference",
      serverName: "beta",
    });
  });

  it("drops names that do not resolve to a discovered tool", () => {
    const { policy } = referenceHarness();

    const outcome = policy.activateSkillReference({
      ...skill,
      referencedTools: ["secret_probe", "not_a_real_tool"],
    });

    expect(outcome.referencedTools).toEqual(["secret_probe"]);
  });

  it("dedupes repeated names while preserving declaration order", () => {
    const h = harness({
      approval: true,
      tools: { alpha: [writeTool, gatedTool] },
    });
    h.policy.registerSkills([skill]);

    const outcome = h.policy.activateSkillReference({
      ...skill,
      referencedTools: ["send_alert", "secret_probe", "send_alert"],
    });

    expect(outcome.referencedTools).toEqual(["send_alert", "secret_probe"]);
  });

  it("activates nothing, and records nothing, for a skill that references no tools", () => {
    const { policy, confirm } = referenceHarness();
    const before = policy.getAuditLog().length;

    const outcome = policy.activateSkillReference({ ...skill, referencedTools: [] });

    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.status).toBe("activated");
    expect(outcome.referencedTools).toEqual([]);
    expect(policy.getAuditLog().length).toBe(before);
  });

  it("dispatches a deferred tool that no skill reference has revealed", async () => {
    const { policy, gateway, confirm } = referenceHarness();

    expect(policy.isDeferred("secret_probe")).toBe(true);
    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "secret_probe",
      args: { city: "lisbon" },
    });

    expect(gateway.callTool).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// HITL from annotations, and no double approval
// ---------------------------------------------------------------------------

describe("tool-call approval semantics", () => {
  it("dispatches read-only tools without prompting", async () => {
    const { policy, confirm, gateway } = harness({ approval: true });

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "read_weather",
      args: { city: "lisbon" },
    });

    expect(confirm).not.toHaveBeenCalled();
    expect(gateway.callTool).toHaveBeenCalledTimes(1);
  });

  it("prompts for a destructive tool and dispatches on approval", async () => {
    const { policy, confirm, gateway } = harness({ approval: true });

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(gateway.callTool).toHaveBeenCalledTimes(1);
    expect(policy.getAuditLog()[0]).toMatchObject({
      decision: "allowed",
      approval: "granted",
    });
  });

  it("treats an unannotated tool as not read-only", async () => {
    const { policy, confirm } = harness({ approval: true });

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "lookup_city",
      args: { city: "lisbon" },
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(isReadOnlyToolCall(unannotatedTool)).toBe(false);
    expect(isReadOnlyToolCall(readOnlyTool)).toBe(true);
    expect(isReadOnlyToolCall(writeTool)).toBe(false);
  });

  it("refuses a declined destructive call before dispatch", async () => {
    const { policy, gateway } = harness({ approval: false });

    await expectDenied(
      policy.callTool({
        source: "tool-cli",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "approval_declined",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("refuses a destructive call when no approval surface exists", async () => {
    const { policy, gateway } = harness({ tools: { alpha: [writeTool] } });

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "approval_unavailable",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("asks again for every execution, because a skill reference grants nothing", async () => {
    const skill: McpPolicySkill = {
      name: "alerts",
      uri: "skill://alerts/SKILL.md",
      serverName: "alpha",
      referencedTools: ["send_alert"],
    };
    const { policy, confirm, gateway } = harness({ approval: true });
    policy.registerSkills([skill]);

    policy.activateSkillReference(skill);
    expect(confirm).not.toHaveBeenCalled();

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
    });
    await policy.callTool({
      source: "tool-cli",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
    });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(gateway.callTool).toHaveBeenCalledTimes(2);
    expect(policy.getAuditLog().at(-1)).toMatchObject({
      decision: "allowed",
      approval: "granted",
    });
  });

  it("propagates the cancellation signal into the approval request", async () => {
    const { policy, confirm } = harness({ approval: true });
    const controller = new AbortController();

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
      signal: controller.signal,
    });

    expect(confirm.mock.calls[0]?.[0].signal).toBe(controller.signal);
  });

  it("treats a thrown approval prompt as no approval", async () => {
    const h = harness({ approval: true });
    h.confirm.mockRejectedValue(new Error("ui exploded"));

    await expectDenied(
      h.policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "approval_unavailable",
    );

    expect(h.gateway.callTool).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Code Mode executes writes through the same approval path
// ---------------------------------------------------------------------------

describe("code-mode approval semantics", () => {
  it("prompts once for a non-read-only tool and dispatches on approval", async () => {
    const { policy, confirm, gateway } = harness({ approval: true });

    await policy.callTool({
      source: "code-mode",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
    });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "tool-call",
      source: "code-mode",
      serverName: "alpha",
      toolName: "send_alert",
    });
    expect(gateway.callTool).toHaveBeenCalledTimes(1);
  });

  it("records exactly one audit crossing for an approved code-mode write", async () => {
    const { policy } = harness({ approval: true });
    const before = policy.getAuditLog().length;

    await policy.callTool({
      source: "code-mode",
      serverName: "alpha",
      toolName: "send_alert",
      args: { city: "lisbon" },
    });

    const added = policy.getAuditLog().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      source: "code-mode",
      operation: "tool",
      toolName: "send_alert",
      decision: "allowed",
      approval: "granted",
    });
  });

  it("declines legibly and never reaches the server", async () => {
    const h = harness({ approval: false });
    const before = h.policy.getAuditLog().length;

    const error = await expectDenied(
      h.policy.callTool({
        source: "code-mode",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "approval_declined",
    );

    expect(h.gateway.callTool).not.toHaveBeenCalled();
    expect(error.message).toContain("send_alert");
    const added = h.policy.getAuditLog().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      decision: "denied",
      approval: "declined",
      reason: "approval_declined",
    });
  });

  it("treats a missing approval surface as no approval", async () => {
    const h = harness({ tools: { alpha: [writeTool] } });

    await expectDenied(
      h.policy.callTool({
        source: "code-mode",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "approval_unavailable",
    );

    expect(h.gateway.callTool).not.toHaveBeenCalled();
  });

  it("allows read-only code-mode calls without prompting", async () => {
    const { policy, gateway, confirm } = harness({ approval: true });

    await policy.callTool({
      source: "code-mode",
      serverName: "alpha",
      toolName: "read_weather",
      args: { city: "lisbon" },
    });

    expect(gateway.callTool).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Resource policy
// ---------------------------------------------------------------------------

describe("resource authorization", () => {
  const alphaSkillUri = "skill://alpha-skill/SKILL.md";
  const betaSkillUri = "skill://beta-skill/SKILL.md";

  function resourceHarness() {
    return harness({
      approval: true,
      tools: { alpha: [readOnlyTool], beta: [readOnlyTool] },
      resources: {
        alpha: [
          { uri: alphaSkillUri, name: "alpha-skill" },
          { uri: "file:///etc/passwd", name: "not-a-skill" },
        ],
        beta: [{ uri: betaSkillUri, name: "beta-skill" }],
      },
    });
  }

  it("lists only skill:// resources and records the discovery pass", async () => {
    const { policy } = resourceHarness();

    const resources = await policy.listSkillResources("alpha");

    expect(resources.map((r) => r.uri)).toEqual([alphaSkillUri]);
  });

  it("lists only non-skill resources for tool-cli and crosses policy once", async () => {
    const { policy, gateway } = resourceHarness();

    const resources = await policy.listResources({
      source: "tool-cli",
      serverName: "alpha",
    });

    expect(resources).toEqual([{ uri: "file:///etc/passwd", name: "not-a-skill" }]);
    expect(gateway.listResources).toHaveBeenCalledOnce();
    expect(policy.getAuditLog()).toEqual([
      expect.objectContaining({
        source: "tool-cli",
        operation: "resource-list",
        serverName: "alpha",
        decision: "allowed",
      }),
    ]);
  });

  it("isolates skill resource templates from tool-cli", async () => {
    const { policy, gateway } = harness({
      tools: { alpha: [readOnlyTool] },
      resourceTemplates: {
        alpha: [
          {
            uriTemplate: "file:///logs/{date}.txt",
            name: "logs",
            _meta: { order: 0 },
          },
          { uriTemplate: "skill://hidden/{path}", name: "hidden" },
        ],
      },
    });

    const templates = await policy.listResourceTemplates({
      source: "tool-cli",
      serverName: "alpha",
    });

    expect(templates).toEqual([
      {
        uriTemplate: "file:///logs/{date}.txt",
        name: "logs",
        _meta: { order: 0 },
      },
    ]);
    expect(gateway.listResourceTemplates).toHaveBeenCalledOnce();
    expect(policy.getAuditLog()).toEqual([
      expect.objectContaining({
        source: "tool-cli",
        operation: "resource-templates",
        decision: "allowed",
      }),
    ]);
  });

  it("isolates skill URI schemes case-insensitively", async () => {
    const { policy, gateway } = harness({
      tools: { alpha: [readOnlyTool] },
      resources: {
        alpha: [
          { uri: "SKILL://hidden/SKILL.md", name: "hidden" },
          { uri: "file:///visible.txt", name: "visible" },
        ],
      },
      resourceTemplates: {
        alpha: [
          { uriTemplate: "Skill://hidden/{path}", name: "hidden" },
          { uriTemplate: "file:///visible/{path}", name: "visible" },
        ],
      },
    });

    await expect(
      policy.listResources({ source: "tool-cli", serverName: "alpha" }),
    ).resolves.toEqual([{ uri: "file:///visible.txt", name: "visible" }]);
    await expect(
      policy.listResourceTemplates({ source: "tool-cli", serverName: "alpha" }),
    ).resolves.toEqual([{ uriTemplate: "file:///visible/{path}", name: "visible" }]);
    await expectDenied(
      policy.readResource({
        source: "tool-cli",
        serverName: "alpha",
        uri: "sKiLl://hidden/SKILL.md",
      }),
      "resource_not_discovered",
    );
    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("isolates SEP-2640 skill-owned resources under arbitrary URI schemes", async () => {
    const skillUri = "https://skills.example/weather/SKILL.md";
    const referenceUri = "https://skills.example/weather/reference.md";
    const { policy, gateway } = harness({
      tools: { alpha: [readOnlyTool] },
      resources: {
        alpha: [
          { uri: skillUri, name: "weather" },
          { uri: referenceUri, name: "reference" },
          { uri: "https://docs.example/visible.md", name: "visible" },
        ],
      },
    });
    policy.registerSkills([
      {
        name: "weather",
        uri: skillUri,
        serverName: "alpha",
        referencedTools: [],
      },
    ]);
    policy.registerSkillResources("alpha", skillUri, [skillUri, referenceUri]);

    await expect(
      policy.listResources({ source: "tool-cli", serverName: "alpha" }),
    ).resolves.toEqual([{ uri: "https://docs.example/visible.md", name: "visible" }]);
    await expectDenied(
      policy.readResource({
        source: "tool-cli",
        serverName: "alpha",
        uri: referenceUri,
      }),
      "resource_not_discovered",
    );
    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("refuses an ordinary tool-cli read whose response contains a skill resource", async () => {
    const { policy, gateway } = resourceHarness();
    gateway.readResource.mockResolvedValueOnce({
      contents: [
        { uri: "file:///ordinary.txt", text: "ordinary" },
        { uri: "SKILL://hidden/SKILL.md", text: "hidden instructions" },
      ],
    });

    await expectDenied(
      policy.readResource({
        source: "tool-cli",
        serverName: "alpha",
        uri: "file:///ordinary.txt",
      }),
      "resource_not_discovered",
    );
    expect(gateway.readResource).toHaveBeenCalledOnce();
    expect(policy.getAuditLog()).toEqual([
      expect.objectContaining({
        source: "tool-cli",
        operation: "resource",
        decision: "denied",
      }),
    ]);
  });

  it("allows ordinary tool-cli resource reads but refuses skill:// before dispatch", async () => {
    const { policy, gateway } = resourceHarness();

    await expect(
      policy.readResource({
        source: "tool-cli",
        serverName: "alpha",
        uri: "file:///ordinary.txt",
      }),
    ).resolves.toEqual({
      contents: [{ uri: "file:///ordinary.txt", text: "body" }],
    });
    expect(gateway.readResource).toHaveBeenCalledOnce();

    await expectDenied(
      policy.readResource({
        source: "tool-cli",
        serverName: "alpha",
        uri: alphaSkillUri,
      }),
      "resource_not_discovered",
    );
    expect(gateway.readResource).toHaveBeenCalledOnce();
    expect(policy.getAuditLog().map((record) => record.decision)).toEqual(["allowed", "denied"]);
  });

  it("refuses a resource read for a disconnected server", async () => {
    const { policy, gateway } = resourceHarness();

    await expectDenied(
      policy.readResource({
        source: "skill-discovery",
        serverName: "nowhere",
        uri: alphaSkillUri,
      }),
      "server_not_connected",
    );

    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("refuses non-skill URIs even after they were listed", async () => {
    const { policy, gateway } = resourceHarness();
    await policy.listSkillResources("alpha");

    await expectDenied(
      policy.readResource({
        source: "skill-discovery",
        serverName: "alpha",
        uri: "file:///etc/passwd",
      }),
      "resource_not_discovered",
    );

    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("refuses an undiscovered skill URI", async () => {
    const { policy, gateway } = resourceHarness();
    await policy.listSkillResources("alpha");

    await expectDenied(
      policy.readResource({
        source: "skill-discovery",
        serverName: "alpha",
        uri: "skill://never-listed/SKILL.md",
      }),
      "resource_not_discovered",
    );

    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("reads a discovered skill resource and audits it", async () => {
    const { policy, gateway } = resourceHarness();
    await policy.listSkillResources("alpha");

    const result = await policy.readResource({
      source: "skill-discovery",
      serverName: "alpha",
      uri: alphaSkillUri,
    });

    expect(result.contents).toHaveLength(1);
    expect(gateway.readResource).toHaveBeenCalledTimes(1);
    expect(policy.getAuditLog().at(-1)).toMatchObject({
      operation: "resource",
      source: "skill-discovery",
      serverName: "alpha",
      uri: alphaSkillUri,
      decision: "allowed",
    });
  });

  it("refuses reading another server's skill URI with an origin mismatch", async () => {
    const { policy, gateway } = resourceHarness();
    await policy.listSkillResources("alpha");
    await policy.listSkillResources("beta");

    const error = await expectDenied(
      policy.readResource({
        source: "skill-discovery",
        serverName: "alpha",
        uri: betaSkillUri,
      }),
      "resource_origin_mismatch",
    );

    expect(error.message).toContain("beta");
    expect(gateway.readResource).not.toHaveBeenCalled();
  });

  it("binds skill-load reads to the registered skill origin", async () => {
    const { policy, gateway } = resourceHarness();
    policy.registerSkills([
      { name: "alpha-skill", uri: alphaSkillUri, serverName: "alpha", referencedTools: [] },
      { name: "beta-skill", uri: betaSkillUri, serverName: "beta", referencedTools: [] },
    ]);

    await policy.readResource({
      source: "skill-load",
      serverName: "alpha",
      uri: alphaSkillUri,
    });
    expect(gateway.readResource).toHaveBeenCalledTimes(1);

    await expectDenied(
      policy.readResource({
        source: "skill-load",
        serverName: "alpha",
        uri: betaSkillUri,
      }),
      "resource_origin_mismatch",
    );
    expect(gateway.readResource).toHaveBeenCalledTimes(1);
  });

  it("does not let a discovery pass authorize a skill-load read", async () => {
    const { policy, gateway } = resourceHarness();
    await policy.listSkillResources("alpha");

    await expectDenied(
      policy.readResource({
        source: "skill-load",
        serverName: "alpha",
        uri: alphaSkillUri,
      }),
      "resource_not_discovered",
    );

    expect(gateway.readResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe("cancellation", () => {
  it("refuses a pre-cancelled tool call before dispatch", async () => {
    const { policy, gateway } = harness({ approval: true });
    const controller = new AbortController();
    controller.abort();

    await expectDenied(
      policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: "lisbon" },
        signal: controller.signal,
      }),
      "cancelled",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("refuses when the caller cancels while approval is pending", async () => {
    const controller = new AbortController();
    const h = harness({ approval: true });
    h.confirm.mockImplementation(async () => {
      controller.abort();
      return true;
    });

    await expectDenied(
      h.policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
        signal: controller.signal,
      }),
      "cancelled",
    );

    expect(h.gateway.callTool).not.toHaveBeenCalled();
  });

  it("forwards the signal to the gateway on an allowed call", async () => {
    const { policy, gateway } = harness({ approval: true });
    const controller = new AbortController();

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "read_weather",
      args: { city: "lisbon" },
      signal: controller.signal,
    });

    expect(gateway.callTool).toHaveBeenCalledWith(
      "alpha",
      "read_weather",
      { city: "lisbon" },
      controller.signal,
    );
  });

  it("refuses a pre-cancelled resource read before dispatch", async () => {
    const { policy, gateway } = harness({
      approval: true,
      resources: { alpha: [{ uri: "skill://a/SKILL.md", name: "a" }] },
    });
    await policy.listSkillResources("alpha");
    const controller = new AbortController();
    controller.abort();

    await expectDenied(
      policy.readResource({
        source: "skill-discovery",
        serverName: "alpha",
        uri: "skill://a/SKILL.md",
        signal: controller.signal,
      }),
      "cancelled",
    );

    expect(gateway.readResource).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Audit context
// ---------------------------------------------------------------------------

describe("audit context", () => {
  it("tags every record with its originating source", async () => {
    const { policy } = harness({ approval: true });

    for (const source of ALL_SOURCES) {
      await policy.callTool({
        source,
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: "lisbon" },
      });
    }

    expect(policy.getAuditLog().map((r) => r.source)).toEqual(ALL_SOURCES);
    expect(new Set(policy.getAuditLog().map((r) => r.id)).size).toBe(3);
  });

  it("notifies an audit observer for allowed and denied operations", async () => {
    const onAudit = vi.fn();
    const policy = new McpPolicy({
      gateway: {
        ...noSkillsExtensionGateway,
        getConnectedServers: () => ["alpha"],
        getToolsForServer: () => [readOnlyTool],
        callTool: () => Promise.resolve(adaptTerminalCallToolResult(PROTOCOL_RESULT)),
        listResources: () => Promise.resolve([]),
        listResourceTemplates: () => Promise.resolve([]),
        readResource: () => Promise.resolve({ contents: [] }),
      },
      approvals: { confirm: () => Promise.resolve(true) },
      onAudit,
    });

    await policy.callTool({
      source: "proxy",
      serverName: "alpha",
      toolName: "read_weather",
      args: { city: "lisbon" },
    });
    await policy
      .callTool({ source: "proxy", serverName: "alpha", toolName: "nope", args: {} })
      .catch(() => undefined);

    expect(onAudit).toHaveBeenCalledTimes(2);
    expect(onAudit.mock.calls[0]?.[0]).toMatchObject({ decision: "allowed" });
    expect(onAudit.mock.calls[1]?.[0]).toMatchObject({ decision: "denied" });
  });

  it("bounds the audit ring buffer", async () => {
    const policy = new McpPolicy({
      gateway: {
        ...noSkillsExtensionGateway,
        getConnectedServers: () => ["alpha"],
        getToolsForServer: () => [readOnlyTool],
        callTool: () => Promise.resolve(adaptTerminalCallToolResult(PROTOCOL_RESULT)),
        listResources: () => Promise.resolve([]),
        listResourceTemplates: () => Promise.resolve([]),
        readResource: () => Promise.resolve({ contents: [] }),
      },
      auditLimit: 3,
    });

    for (let i = 0; i < 5; i++) {
      await policy.callTool({
        source: "proxy",
        serverName: "alpha",
        toolName: "read_weather",
        args: { city: `city-${i}` },
      });
    }

    expect(policy.getAuditLog()).toHaveLength(3);
  });

  it("clears deferral and activated references on reset", () => {
    const skill: McpPolicySkill = {
      name: "probe",
      uri: "skill://probe/SKILL.md",
      serverName: "alpha",
      referencedTools: ["secret_probe"],
    };
    const { policy } = harness({ approval: true, tools: { alpha: [gatedTool] } });
    policy.registerSkills([skill]);
    policy.activateSkillReference(skill);
    expect(policy.isDeferred("secret_probe")).toBe(false);

    policy.reset();

    expect(policy.getDeferredToolNames()).toEqual([]);
    expect(policy.getAuditLog()).toHaveLength(0);

    // A fresh session re-defers the definition and treats the reference as new.
    policy.registerSkills([skill]);
    expect(policy.isDeferred("secret_probe")).toBe(true);
    expect(policy.activateSkillReference(skill).status).toBe("activated");
  });
});
