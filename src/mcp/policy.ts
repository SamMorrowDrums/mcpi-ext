import { createHash } from "node:crypto";
import type { ReadResourceResult, Resource } from "@modelcontextprotocol/client";
import type { TerminalCallToolResult } from "./call-tool-result.js";
import type { McpTool } from "./client-manager.js";

/**
 * Which execution path asked for an MCP operation. Recorded on every audit
 * record so a denial can be attributed to the surface that produced it.
 */
export type McpCallSource = "proxy" | "code-mode" | "tool-cli";

/**
 * Which skill workflow asked for a resource read. Resource authorization is
 * narrower than tool authorization: only skill discovery and skill loading
 * currently need it, and each is bound to a single server origin.
 */
export type McpResourceSource = "skill-discovery" | "skill-load";

export type McpPolicyDenialReason =
  | "server_not_connected"
  | "tool_not_discovered"
  | "tool_gated"
  | "invalid_arguments"
  | "permission_denied"
  | "approval_declined"
  | "approval_unavailable"
  | "cancelled"
  | "resource_not_discovered"
  | "resource_origin_mismatch";

export interface McpPolicyErrorInit {
  reason: McpPolicyDenialReason;
  message: string;
  source: McpCallSource | McpResourceSource;
  serverName: string;
  toolName?: string;
  uri?: string;
  alternatives?: readonly string[];
}

/** A denial raised by the policy boundary before any upstream MCP request. */
export class McpPolicyError extends Error {
  readonly reason: McpPolicyDenialReason;
  readonly source: McpCallSource | McpResourceSource;
  readonly serverName: string;
  readonly toolName?: string;
  readonly uri?: string;
  readonly alternatives: readonly string[];

  constructor(init: McpPolicyErrorInit) {
    super(init.message);
    this.name = "McpPolicyError";
    this.reason = init.reason;
    this.source = init.source;
    this.serverName = init.serverName;
    this.toolName = init.toolName;
    this.uri = init.uri;
    this.alternatives = init.alternatives ?? [];
  }
}

export type McpApprovalOutcome = "granted" | "reused" | "declined" | "unavailable";

export interface McpAuditRecord {
  readonly id: string;
  readonly source: McpCallSource | McpResourceSource;
  readonly operation: "tool" | "resource" | "skill-grant";
  readonly serverName: string;
  readonly toolName?: string;
  readonly uri?: string;
  readonly decision: "allowed" | "denied";
  readonly reason?: McpPolicyDenialReason;
  readonly approval?: McpApprovalOutcome;
  readonly timestampMs: number;
}

/** Describes a pending confirmation so hosts can render an accurate prompt. */
export interface McpApprovalRequest {
  readonly kind: "tool-call" | "skill-grant";
  readonly source: McpCallSource;
  readonly serverName: string;
  readonly toolName?: string;
  readonly skillName?: string;
  readonly grantedTools?: readonly string[];
  readonly title: string;
  readonly message: string;
  readonly signal?: AbortSignal;
}

/**
 * Host confirmation seam. Returning `undefined` means no decision could be
 * obtained (no interactive UI, or the prompt was cancelled); it is never
 * treated as approval.
 */
export interface McpApprovalPrompt {
  confirm(request: McpApprovalRequest): Promise<boolean | undefined>;
}

/** The upstream surface the policy is allowed to dispatch to. */
export interface McpPolicyGateway {
  getConnectedServers(): string[];
  getToolsForServer(name: string): McpTool[];
  callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TerminalCallToolResult>;
  listResources(serverName: string, signal?: AbortSignal): Promise<Resource[]>;
  readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;
}

export interface McpToolCallRequest {
  source: McpCallSource;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface McpResourceReadRequest {
  source: McpResourceSource;
  serverName: string;
  uri: string;
  signal?: AbortSignal;
}

/** Minimum skill shape the policy needs; mirrors `McpSkillMetadata`. */
export interface McpPolicySkill {
  readonly name: string;
  readonly uri: string;
  readonly serverName: string;
  readonly allowedTools: readonly string[];
}

export type SkillGrantOutcome =
  | { readonly status: "granted"; readonly activatedTools: readonly string[] }
  | { readonly status: "reused"; readonly activatedTools: readonly string[] }
  | { readonly status: "declined"; readonly message: string }
  | { readonly status: "unavailable"; readonly message: string };

export interface McpPolicyOptions {
  gateway: McpPolicyGateway;
  approvals?: McpApprovalPrompt;
  /** Bounded audit ring buffer size. */
  auditLimit?: number;
  onAudit?: (record: McpAuditRecord) => void;
}

const DEFAULT_AUDIT_LIMIT = 500;
const NUL = "\u0000";

/**
 * The single MCP policy and dispatch boundary.
 *
 * Every execution path — deferred/direct proxy tools, Code Mode dispatch,
 * tool-cli provider RPC, and skill resource reads — crosses this class exactly
 * once per operation. Discovery, gating, argument validation, permission
 * semantics, approval, cancellation, and audit all happen here, and nothing
 * reaches an MCP server without passing through `dispatchToolCall` /
 * `dispatchResourceRead` below.
 */
export class McpPolicy {
  private readonly gateway: McpPolicyGateway;
  private readonly approvals: McpApprovalPrompt | undefined;
  private readonly auditLimit: number;
  private readonly onAudit: ((record: McpAuditRecord) => void) | undefined;

  /** Tools that require an approved skill grant before any path may call them. */
  private readonly gatedTools = new Map<string, Set<string>>();
  /** Tools unlocked by an approved, activated skill grant. */
  private readonly enabledTools = new Set<string>();
  /** Approved skill grant keys, bound to server origin plus grant content. */
  private readonly approvedGrants = new Set<string>();
  /** Skill URIs registered per server origin, for `skill-load` authorization. */
  private readonly skillUrisByServer = new Map<string, Set<string>>();
  /** URIs a server itself listed in the current discovery pass. */
  private readonly discoveredUrisByServer = new Map<string, Set<string>>();
  private readonly audit: McpAuditRecord[] = [];
  private sequence = 0;

  constructor(options: McpPolicyOptions) {
    this.gateway = options.gateway;
    this.approvals = options.approvals;
    this.auditLimit = options.auditLimit ?? DEFAULT_AUDIT_LIMIT;
    this.onAudit = options.onAudit;
  }

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /** Register discovered skills so their tools are gated and their URIs bound. */
  registerSkills(skills: readonly McpPolicySkill[]): void {
    for (const skill of skills) {
      const key = skillGrantKey(skill);
      for (const tool of skill.allowedTools) {
        let owners = this.gatedTools.get(tool);
        if (!owners) {
          owners = new Set<string>();
          this.gatedTools.set(tool, owners);
        }
        owners.add(skill.name);
      }

      let uris = this.skillUrisByServer.get(skill.serverName);
      if (!uris) {
        uris = new Set<string>();
        this.skillUrisByServer.set(skill.serverName, uris);
      }
      uris.add(skill.uri);
      // Registration alone never approves; `key` is only recomputed on activation.
      void key;
    }
  }

  /** Every tool name currently gated behind an unapproved skill grant. */
  getGatedToolNames(): string[] {
    return [...this.gatedTools.keys()].filter((name) => !this.enabledTools.has(name)).sort();
  }

  /** Skills that gate `toolName`, for actionable block messages. */
  getGatingSkills(toolName: string): string[] {
    return [...(this.gatedTools.get(toolName) ?? [])].sort();
  }

  /** True when a tool is discovered but still requires an approved skill grant. */
  isGated(toolName: string): boolean {
    return this.gatedTools.has(toolName) && !this.enabledTools.has(toolName);
  }

  reset(): void {
    this.gatedTools.clear();
    this.enabledTools.clear();
    this.approvedGrants.clear();
    this.skillUrisByServer.clear();
    this.discoveredUrisByServer.clear();
    this.audit.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Visibility (what tool-cli and other discovery surfaces may see)
  // ---------------------------------------------------------------------------

  getVisibleServers(): string[] {
    return this.gateway.getConnectedServers();
  }

  /**
   * The exact discovered schema set a discovery surface may see. Gated tools
   * are omitted entirely, so a surface cannot learn a hidden tool's name or
   * schema and then try to call it.
   */
  getVisibleTools(serverName: string): McpTool[] {
    return this.gateway.getToolsForServer(serverName).filter((tool) => !this.isGated(tool.name));
  }

  // ---------------------------------------------------------------------------
  // Skill grants
  // ---------------------------------------------------------------------------

  /**
   * Activate an MCP-origin skill's `allowed-tools` grant.
   *
   * The grant is origin- and content-bound: the key covers the server name, the
   * skill URI, and a digest of the exact tool list being granted. A previously
   * approved identical grant is reused without re-prompting, so no path ever
   * asks the user twice for the same authority. Declined, cancelled, and
   * unavailable outcomes all leave the tools gated.
   */
  async activateSkillGrant(
    skill: McpPolicySkill,
    signal?: AbortSignal,
  ): Promise<SkillGrantOutcome> {
    if (skill.allowedTools.length === 0) {
      return { status: "granted", activatedTools: [] };
    }

    const key = skillGrantKey(skill);
    if (this.approvedGrants.has(key)) {
      this.enableTools(skill.allowedTools);
      this.record({
        source: "skill-load",
        operation: "skill-grant",
        serverName: skill.serverName,
        uri: skill.uri,
        decision: "allowed",
        approval: "reused",
      });
      return { status: "reused", activatedTools: [...skill.allowedTools] };
    }

    if (signal?.aborted) {
      this.record({
        source: "skill-load",
        operation: "skill-grant",
        serverName: skill.serverName,
        uri: skill.uri,
        decision: "denied",
        reason: "cancelled",
        approval: "unavailable",
      });
      return {
        status: "unavailable",
        message: `Loading skill "${skill.name}" was cancelled before its tool grant could be approved. No tools were activated.`,
      };
    }

    const granted = await this.requestApproval({
      kind: "skill-grant",
      source: "proxy",
      serverName: skill.serverName,
      skillName: skill.name,
      grantedTools: [...skill.allowedTools],
      title: `Activate MCP skill "${skill.name}"?`,
      message:
        `MCP server "${skill.serverName}" offers skill "${skill.name}" (${skill.uri}).\n` +
        `Approving activates these tools for this session:\n` +
        skill.allowedTools.map((tool) => `  - ${tool}`).join("\n"),
      ...(signal ? { signal } : {}),
    });

    if (granted === true) {
      this.approvedGrants.add(key);
      this.enableTools(skill.allowedTools);
      this.record({
        source: "skill-load",
        operation: "skill-grant",
        serverName: skill.serverName,
        uri: skill.uri,
        decision: "allowed",
        approval: "granted",
      });
      return { status: "granted", activatedTools: [...skill.allowedTools] };
    }

    const approval: McpApprovalOutcome = granted === false ? "declined" : "unavailable";
    this.record({
      source: "skill-load",
      operation: "skill-grant",
      serverName: skill.serverName,
      uri: skill.uri,
      decision: "denied",
      reason: granted === false ? "approval_declined" : "approval_unavailable",
      approval,
    });

    const toolList = skill.allowedTools.join(", ");
    return {
      status: approval,
      message:
        granted === false
          ? `Activation of skill "${skill.name}" was declined, so its tools (${toolList}) remain unavailable. Call load_skill again and approve the prompt to activate them.`
          : `Activation of skill "${skill.name}" needs explicit approval, but no interactive confirmation was available, so its tools (${toolList}) remain unavailable. Run this session interactively and call load_skill again to approve.`,
    };
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  /**
   * Authorize and dispatch a tool call. Every execution path funnels here, and
   * upstream is reached only after all checks below pass.
   */
  async callTool(request: McpToolCallRequest): Promise<TerminalCallToolResult> {
    const { source, serverName, toolName, args, signal } = request;

    const deny = (reason: McpPolicyDenialReason, message: string, alternatives?: string[]) => {
      this.record({
        source,
        operation: "tool",
        serverName,
        toolName,
        decision: "denied",
        reason,
      });
      return new McpPolicyError({
        reason,
        message,
        source,
        serverName,
        toolName,
        ...(alternatives ? { alternatives } : {}),
      });
    };

    if (!this.gateway.getConnectedServers().includes(serverName)) {
      throw deny(
        "server_not_connected",
        `MCP server "${serverName}" is not connected, so "${toolName}" cannot be called.`,
      );
    }

    // Discovery check: an undiscovered tool name never reaches upstream.
    const tool = this.gateway
      .getToolsForServer(serverName)
      .find((candidate) => candidate.name === toolName);
    if (!tool) {
      throw deny(
        "tool_not_discovered",
        `Tool "${toolName}" was not discovered on MCP server "${serverName}". Only discovered tools can be called.`,
      );
    }

    // Gating check: applies to every source, so no surface can bypass a skill
    // grant by naming a tool it was never shown.
    if (this.isGated(toolName)) {
      const skills = this.getGatingSkills(toolName);
      throw deny(
        "tool_gated",
        `Tool "${toolName}" requires an approved skill grant first. Call load_skill with one of: ${skills.join(", ") || "(none)"}`,
        ["load_skill"],
      );
    }

    const invalid = validateToolArguments(tool.inputSchema, args);
    if (invalid) {
      throw deny(
        "invalid_arguments",
        `Arguments for "${toolName}" do not satisfy its declared input schema: ${invalid}`,
      );
    }

    if (signal?.aborted) {
      throw deny("cancelled", `Call to "${toolName}" was cancelled before dispatch.`);
    }

    // Permission semantics. Code Mode keeps its strict read-only contract; the
    // interactive paths use the same annotations to drive HITL.
    const readOnly = isReadOnlyToolCall(tool);
    // A tool activated by an approved skill grant is already covered by that
    // approval, so it must not prompt again on every call.
    const grantCovered = this.enabledTools.has(toolName);
    let approval: McpApprovalOutcome | undefined;
    if (source === "code-mode") {
      if (!readOnly) {
        throw deny(
          "permission_denied",
          `Tool "${toolName}" is visible for discovery but cannot be called from Code Mode. ` +
            "Use load_skill or tool-cli through the host's permission-aware path.",
          ["load_skill", "tool-cli"],
        );
      }
    } else if (!readOnly && grantCovered) {
      approval = "reused";
    } else if (!readOnly) {
      const approved = await this.requestApproval({
        kind: "tool-call",
        source,
        serverName,
        toolName,
        title: `Run MCP tool "${toolName}"?`,
        message: formatToolApprovalMessage(source, serverName, tool, args),
        ...(signal ? { signal } : {}),
      });

      if (approved !== true) {
        const reason: McpPolicyDenialReason =
          approved === false ? "approval_declined" : "approval_unavailable";
        this.record({
          source,
          operation: "tool",
          serverName,
          toolName,
          decision: "denied",
          reason,
          approval: approved === false ? "declined" : "unavailable",
        });
        throw new McpPolicyError({
          reason,
          source,
          serverName,
          toolName,
          message:
            approved === false
              ? `Running "${toolName}" was declined, so it was not executed. Re-run the tool and approve the prompt if you want it to proceed.`
              : `Running "${toolName}" needs explicit approval because it is not annotated read-only, but no interactive confirmation was available, so it was not executed. Run this session interactively to approve it.`,
        });
      }
      approval = "granted";
    }

    if (signal?.aborted) {
      throw deny("cancelled", `Call to "${toolName}" was cancelled before dispatch.`);
    }

    const terminal = await this.gateway.callTool(serverName, toolName, args, signal);
    this.record({
      source,
      operation: "tool",
      serverName,
      toolName,
      decision: "allowed",
      ...(approval ? { approval } : {}),
    });
    return terminal;
  }

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  /**
   * List a server's skill resources and remember them as this pass's discovery
   * candidates. Only URIs seen here become readable under `skill-discovery`.
   */
  async listSkillResources(serverName: string, signal?: AbortSignal): Promise<Resource[]> {
    if (!this.gateway.getConnectedServers().includes(serverName)) {
      this.record({
        source: "skill-discovery",
        operation: "resource",
        serverName,
        decision: "denied",
        reason: "server_not_connected",
      });
      throw new McpPolicyError({
        reason: "server_not_connected",
        message: `MCP server "${serverName}" is not connected.`,
        source: "skill-discovery",
        serverName,
      });
    }

    const resources = await this.gateway.listResources(serverName, signal);
    const skillResources = resources.filter(isSkillResourceUri);
    this.discoveredUrisByServer.set(serverName, new Set(skillResources.map((r) => r.uri)));
    return skillResources;
  }

  /**
   * Authorize and dispatch a resource read using the same policy discipline as
   * tool calls: origin binding, discovery, cancellation, and audit.
   */
  async readResource(request: McpResourceReadRequest): Promise<ReadResourceResult> {
    const { source, serverName, uri, signal } = request;

    const deny = (reason: McpPolicyDenialReason, message: string) => {
      this.record({
        source,
        operation: "resource",
        serverName,
        uri,
        decision: "denied",
        reason,
      });
      return new McpPolicyError({ reason, message, source, serverName, uri });
    };

    if (!this.gateway.getConnectedServers().includes(serverName)) {
      throw deny(
        "server_not_connected",
        `MCP server "${serverName}" is not connected, so ${uri} cannot be read.`,
      );
    }

    if (!uri.startsWith("skill://")) {
      throw deny(
        "resource_not_discovered",
        `Resource ${uri} is outside the skill resource surface this host authorizes.`,
      );
    }

    const allowed =
      source === "skill-discovery"
        ? (this.discoveredUrisByServer.get(serverName) ?? new Set<string>())
        : (this.skillUrisByServer.get(serverName) ?? new Set<string>());

    if (!allowed.has(uri)) {
      // Distinguish "belongs to a different origin" so the denial is actionable.
      const otherOrigin = this.findOtherOrigin(uri, serverName, source);
      if (otherOrigin) {
        throw deny(
          "resource_origin_mismatch",
          `Resource ${uri} belongs to MCP server "${otherOrigin}" and cannot be read through server "${serverName}".`,
        );
      }
      throw deny(
        "resource_not_discovered",
        `Resource ${uri} was not discovered as a skill on MCP server "${serverName}".`,
      );
    }

    if (signal?.aborted) {
      throw deny("cancelled", `Read of ${uri} was cancelled before dispatch.`);
    }

    const result = await this.gateway.readResource(serverName, uri, signal);
    this.record({
      source,
      operation: "resource",
      serverName,
      uri,
      decision: "allowed",
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Audit
  // ---------------------------------------------------------------------------

  getAuditLog(): readonly McpAuditRecord[] {
    return [...this.audit];
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private enableTools(tools: readonly string[]): void {
    for (const tool of tools) {
      this.enabledTools.add(tool);
    }
  }

  private findOtherOrigin(
    uri: string,
    serverName: string,
    source: McpResourceSource,
  ): string | undefined {
    const index =
      source === "skill-discovery" ? this.discoveredUrisByServer : this.skillUrisByServer;
    for (const [candidate, uris] of index) {
      if (candidate !== serverName && uris.has(uri)) return candidate;
    }
    return undefined;
  }

  private async requestApproval(request: McpApprovalRequest): Promise<boolean | undefined> {
    if (!this.approvals) return undefined;
    try {
      return await this.approvals.confirm(request);
    } catch {
      // A failed or cancelled prompt is never an approval.
      return undefined;
    }
  }

  private record(record: Omit<McpAuditRecord, "id" | "timestampMs">): void {
    const entry: McpAuditRecord = {
      ...record,
      id: `mcp-policy-${++this.sequence}`,
      timestampMs: Date.now(),
    };
    this.audit.push(entry);
    if (this.audit.length > this.auditLimit) {
      this.audit.splice(0, this.audit.length - this.auditLimit);
    }
    this.onAudit?.(entry);
  }
}

/**
 * A tool call is treated as read-only only when the server explicitly declares
 * it read-only and does not also declare it destructive. This is the same
 * predicate Code Mode uses for dispatch eligibility.
 */
export function isReadOnlyToolCall(tool: McpTool): boolean {
  return tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true;
}

function isSkillResourceUri(resource: Resource): boolean {
  return resource.uri.startsWith("skill://") && resource.uri.endsWith("/SKILL.md");
}

function skillGrantKey(skill: McpPolicySkill): string {
  const tools = [...skill.allowedTools].sort().join(" ");
  const digest = createHash("sha256").update(tools).digest("hex").slice(0, 32);
  return [skill.serverName, skill.uri, digest].join(NUL);
}

function formatToolApprovalMessage(
  source: McpCallSource,
  serverName: string,
  tool: McpTool,
  args: Record<string, unknown>,
): string {
  const annotations = tool.annotations ?? {};
  const flags: string[] = [];
  if (annotations.readOnlyHint !== true) flags.push("not annotated read-only");
  if (annotations.destructiveHint === true) flags.push("annotated destructive");

  let preview: string;
  try {
    preview = JSON.stringify(args, null, 2) ?? "{}";
  } catch {
    preview = "(arguments could not be serialized)";
  }
  if (preview.length > 2000) preview = `${preview.slice(0, 2000)}\n… (truncated)`;

  return [
    `Requested by: ${source}`,
    `MCP server: ${serverName}`,
    `Tool: ${tool.name}${flags.length > 0 ? ` (${flags.join("; ")})` : ""}`,
    "Arguments:",
    preview,
  ].join("\n");
}

/**
 * Conservative, dependency-free structural validation of tool arguments.
 *
 * It rejects only what a server's own declared schema unambiguously forbids —
 * missing required properties, undeclared properties under
 * `additionalProperties: false`, and clearly mismatched primitive types — so
 * schemas using `$ref`, `allOf`, or other composition keywords are not
 * incorrectly refused. Returns a message when invalid, otherwise `undefined`.
 */
export function validateToolArguments(
  schema: McpTool["inputSchema"] | undefined,
  args: unknown,
): string | undefined {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return "arguments must be a JSON object";
  }
  if (!schema || typeof schema !== "object") return undefined;

  const record = args as Record<string, unknown>;
  const schemaRecord = schema as Record<string, unknown>;

  const required = collectRequired(schemaRecord);
  const missing = required.filter((name) => record[name] === undefined);
  if (missing.length > 0) {
    return `missing required propert${missing.length === 1 ? "y" : "ies"}: ${missing.join(", ")}`;
  }

  const properties = asRecord(schemaRecord.properties);
  if (schemaRecord.additionalProperties === false && properties) {
    const declared = new Set(Object.keys(properties));
    const patterns = asRecord(schemaRecord.patternProperties);
    const patternKeys = patterns ? Object.keys(patterns).map((p) => new RegExp(p)) : [];
    const unknown = Object.keys(record).filter(
      (key) => !declared.has(key) && !patternKeys.some((re) => re.test(key)),
    );
    if (unknown.length > 0) {
      return `unknown propert${unknown.length === 1 ? "y" : "ies"}: ${unknown.join(", ")}`;
    }
  }

  if (properties) {
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      const propSchema = asRecord(properties[key]);
      const expected = propSchema?.type;
      if (typeof expected !== "string") continue;
      if (!matchesJsonType(value, expected)) {
        return `property "${key}" must be of type ${expected}`;
      }
    }
  }

  return undefined;
}

function collectRequired(schema: Record<string, unknown>): string[] {
  const names = new Set<string>();
  const push = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const entry of value) {
      if (typeof entry === "string") names.add(entry);
    }
  };

  push(schema.required);
  // `allOf` composition is common in MCP schemas; honor top-level required only.
  if (Array.isArray(schema.allOf)) {
    for (const branch of schema.allOf) {
      const record = asRecord(branch);
      if (record) push(record.required);
    }
  }
  return [...names];
}

function matchesJsonType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
