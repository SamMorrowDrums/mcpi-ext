import type { ReadResourceResult, Resource } from "@modelcontextprotocol/client";
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
    readResource: readResource as unknown as McpPolicyGateway["readResource"],
  };

  const confirm = vi.fn<(request: McpApprovalRequest) => Promise<boolean | undefined>>();
  confirm.mockResolvedValue(options.approval);

  const policy = new McpPolicy({
    gateway,
    ...("approval" in options ? { approvals: { confirm } } : {}),
  });

  return { policy, gateway: { callTool, listResources, readResource }, confirm };
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
// Gating + tool-cli visibility (no hidden-tool bypass)
// ---------------------------------------------------------------------------

describe("gating and discovery visibility", () => {
  const skill: McpPolicySkill = {
    name: "probe",
    uri: "skill://probe/SKILL.md",
    serverName: "alpha",
    allowedTools: ["secret_probe"],
  };

  it("omits gated tools from the policy-visible discovered schema set", () => {
    const { policy } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool, gatedTool] },
    });
    policy.registerSkills([skill]);

    const visible = policy.getVisibleTools("alpha").map((t) => t.name);
    expect(visible).toEqual(["read_weather"]);
    expect(policy.isGated("secret_probe")).toBe(true);
    expect(policy.getGatingSkills("secret_probe")).toEqual(["probe"]);
  });

  it("refuses a tool-cli call that names a hidden tool directly", async () => {
    const { policy, gateway } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool, gatedTool] },
    });
    policy.registerSkills([skill]);

    const error = await expectDenied(
      policy.callTool({
        source: "tool-cli",
        serverName: "alpha",
        toolName: "secret_probe",
        args: { city: "lisbon" },
      }),
      "tool_gated",
    );

    expect(error.alternatives).toContain("load_skill");
    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it.each(ALL_SOURCES)("applies gating to the %s path as well", async (source) => {
    const { policy, gateway } = harness({
      approval: true,
      tools: { alpha: [gatedTool] },
    });
    policy.registerSkills([skill]);

    await expectDenied(
      policy.callTool({
        source,
        serverName: "alpha",
        toolName: "secret_probe",
        args: { city: "lisbon" },
      }),
      "tool_gated",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("exposes gated names to the host gate without leaking them to discovery", () => {
    const { policy } = harness({
      approval: true,
      tools: { alpha: [readOnlyTool, gatedTool] },
    });
    policy.registerSkills([skill]);

    expect(policy.getGatedToolNames()).toEqual(["secret_probe"]);
    expect(policy.getVisibleServers()).toEqual(["alpha"]);
  });
});

// ---------------------------------------------------------------------------
// Skill allowed-tools grants require approval
// ---------------------------------------------------------------------------

describe("skill grant approval", () => {
  const skill: McpPolicySkill = {
    name: "probe",
    uri: "skill://probe/SKILL.md",
    serverName: "alpha",
    allowedTools: ["secret_probe"],
  };

  function grantHarness(approval: boolean | undefined) {
    const h = harness({ approval, tools: { alpha: [gatedTool] } });
    h.policy.registerSkills([skill]);
    return h;
  }

  it("activates only after explicit approval", async () => {
    const { policy, confirm } = grantHarness(true);

    expect(policy.isGated("secret_probe")).toBe(true);
    const outcome = await policy.activateSkillGrant(skill);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]?.[0]).toMatchObject({
      kind: "skill-grant",
      serverName: "alpha",
      skillName: "probe",
      grantedTools: ["secret_probe"],
    });
    expect(outcome.status).toBe("granted");
    expect(policy.isGated("secret_probe")).toBe(false);
  });

  it("leaves tools gated and returns an actionable message when declined", async () => {
    const { policy, confirm } = grantHarness(false);

    const outcome = await policy.activateSkillGrant(skill);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("declined");
    expect("message" in outcome && outcome.message).toContain("load_skill");
    expect(policy.isGated("secret_probe")).toBe(true);
    expect(policy.getAuditLog().at(-1)).toMatchObject({
      operation: "skill-grant",
      decision: "denied",
      approval: "declined",
    });
  });

  it("leaves tools gated when no approval surface is available", async () => {
    const h = harness({ tools: { alpha: [gatedTool] } });
    h.policy.registerSkills([skill]);

    const outcome = await h.policy.activateSkillGrant(skill);

    expect(outcome.status).toBe("unavailable");
    expect("message" in outcome && outcome.message.length).toBeGreaterThan(0);
    expect(h.policy.isGated("secret_probe")).toBe(true);
  });

  it("treats a cancelled activation as unavailable, not approved", async () => {
    const { policy, confirm } = grantHarness(true);
    const controller = new AbortController();
    controller.abort();

    const outcome = await policy.activateSkillGrant(skill, controller.signal);

    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.status).toBe("unavailable");
    expect(policy.isGated("secret_probe")).toBe(true);
  });

  it("reuses an identical approved grant without prompting again", async () => {
    const { policy, confirm } = grantHarness(true);

    await policy.activateSkillGrant(skill);
    const second = await policy.activateSkillGrant(skill);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(second.status).toBe("reused");
  });

  it("re-prompts when the same skill URI grants a different tool set", async () => {
    const { policy, confirm } = grantHarness(true);
    await policy.activateSkillGrant(skill);

    const widened: McpPolicySkill = { ...skill, allowedTools: ["secret_probe", "send_alert"] };
    await policy.activateSkillGrant(widened);

    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("re-prompts when an identical tool set arrives from another origin", async () => {
    const h = harness({
      approval: true,
      tools: { alpha: [gatedTool], beta: [gatedTool] },
    });
    h.policy.registerSkills([skill]);
    await h.policy.activateSkillGrant(skill);

    await h.policy.activateSkillGrant({ ...skill, serverName: "beta" });

    expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("does not prompt for a skill that grants no tools", async () => {
    const { policy, confirm } = grantHarness(true);

    const outcome = await policy.activateSkillGrant({ ...skill, allowedTools: [] });

    expect(confirm).not.toHaveBeenCalled();
    expect(outcome.status).toBe("granted");
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

  it("never double-approves a tool already covered by an approved skill grant", async () => {
    const skill: McpPolicySkill = {
      name: "alerts",
      uri: "skill://alerts/SKILL.md",
      serverName: "alpha",
      allowedTools: ["send_alert"],
    };
    const { policy, confirm, gateway } = harness({ approval: true });
    policy.registerSkills([skill]);

    await policy.activateSkillGrant(skill);
    expect(confirm).toHaveBeenCalledTimes(1);

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

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(gateway.callTool).toHaveBeenCalledTimes(2);
    expect(policy.getAuditLog().at(-1)).toMatchObject({
      decision: "allowed",
      approval: "reused",
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
// Code Mode read-only semantics preserved
// ---------------------------------------------------------------------------

describe("code-mode permission semantics", () => {
  it("refuses a non-read-only tool from code-mode without prompting", async () => {
    const { policy, confirm, gateway } = harness({ approval: true });

    const error = await expectDenied(
      policy.callTool({
        source: "code-mode",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "permission_denied",
    );

    expect(confirm).not.toHaveBeenCalled();
    expect(gateway.callTool).not.toHaveBeenCalled();
    expect(error.message).toContain("visible for discovery but cannot be called from Code Mode");
    expect(error.alternatives).toEqual(["load_skill", "tool-cli"]);
  });

  it("still refuses code-mode writes after a skill grant approved them elsewhere", async () => {
    const skill: McpPolicySkill = {
      name: "alerts",
      uri: "skill://alerts/SKILL.md",
      serverName: "alpha",
      allowedTools: ["send_alert"],
    };
    const { policy, gateway } = harness({ approval: true });
    policy.registerSkills([skill]);
    await policy.activateSkillGrant(skill);

    await expectDenied(
      policy.callTool({
        source: "code-mode",
        serverName: "alpha",
        toolName: "send_alert",
        args: { city: "lisbon" },
      }),
      "permission_denied",
    );

    expect(gateway.callTool).not.toHaveBeenCalled();
  });

  it("allows read-only code-mode calls", async () => {
    const { policy, gateway } = harness({ approval: true });

    await policy.callTool({
      source: "code-mode",
      serverName: "alpha",
      toolName: "read_weather",
      args: { city: "lisbon" },
    });

    expect(gateway.callTool).toHaveBeenCalledTimes(1);
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
      { name: "alpha-skill", uri: alphaSkillUri, serverName: "alpha", allowedTools: [] },
      { name: "beta-skill", uri: betaSkillUri, serverName: "beta", allowedTools: [] },
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

  it("clears gating and grants on reset", async () => {
    const skill: McpPolicySkill = {
      name: "probe",
      uri: "skill://probe/SKILL.md",
      serverName: "alpha",
      allowedTools: ["secret_probe"],
    };
    const { policy, confirm } = harness({ approval: true, tools: { alpha: [gatedTool] } });
    policy.registerSkills([skill]);
    await policy.activateSkillGrant(skill);
    expect(policy.isGated("secret_probe")).toBe(false);

    policy.reset();

    expect(policy.getGatedToolNames()).toEqual([]);
    expect(policy.getAuditLog()).toHaveLength(0);

    policy.registerSkills([skill]);
    await policy.activateSkillGrant(skill);
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
