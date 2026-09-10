import { createHash } from "node:crypto";
import type {
  ReadResourceResult,
  Resource,
  ResourceTemplateType,
} from "@modelcontextprotocol/client";
import type {
  DirectoryReadResult,
  SkillsGetResult,
  SkillsListResult,
} from "../skills/sep2640/protocol.js";
import { SKILLS_EXTENSION_NAME } from "../skills/sep2640/spec.js";
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
 *
 * `skills-extension` covers the draft SEP-2640 surface. It is a distinct source
 * so a read authorized by a skill's declared `resources` set can never be
 * confused with one authorized by the legacy `skill://…/SKILL.md` convention,
 * and so the audit log says which contract produced each read.
 */
export type McpResourceSource = "skill-discovery" | "skill-load" | "skills-extension" | "tool-cli";

export type McpPolicyDenialReason =
  | "server_not_connected"
  | "tool_not_discovered"
  | "invalid_arguments"
  | "approval_declined"
  | "approval_unavailable"
  | "cancelled"
  | "resource_not_discovered"
  | "resource_origin_mismatch"
  /** The server never declared the skills extension, so its methods are off-limits. */
  | "extension_not_declared"
  /** The server declared the extension but not `directoryRead`. */
  | "directory_read_unavailable";

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

export type McpApprovalOutcome = "granted" | "declined" | "unavailable";

export interface McpAuditRecord {
  readonly id: string;
  readonly source: McpCallSource | McpResourceSource;
  readonly operation:
    | "tool"
    | "resource"
    | "resource-list"
    | "resource-templates"
    | "skill-reference"
    | "skill-list"
    | "skill-get"
    | "skill-directory";
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
  /**
   * Always a tool call. Approval is an *execution* decision: nothing in this
   * host prompts to make a schema visible, so there is no discovery- or
   * activation-shaped approval to describe.
   */
  readonly kind: "tool-call";
  readonly source: McpCallSource;
  readonly serverName: string;
  readonly toolName: string;
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
  listResourceTemplates(serverName: string, signal?: AbortSignal): Promise<ResourceTemplateType[]>;
  readResource(serverName: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult>;

  /**
   * The settings a server declared for one MCP extension in its `initialize`
   * response, or `undefined` when it did not declare that extension at all.
   *
   * Read fresh on every call rather than cached as a boolean: the policy asks
   * this immediately before each extension request so a reconnect that drops
   * the extension cannot leave a stale "enabled" flag behind.
   */
  getExtensionCapability(
    serverName: string,
    extensionName: string,
  ): Record<string, unknown> | undefined;

  /** Draft SEP-2640 `skills/list`. */
  requestSkillsList(
    serverName: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SkillsListResult>;
  /** Draft SEP-2640 `skills/get`. */
  requestSkillsGet(serverName: string, uri: string, signal?: AbortSignal): Promise<SkillsGetResult>;
  /** Draft SEP-2640 `resources/directory/read`. */
  requestDirectoryRead(
    serverName: string,
    uri: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryReadResult>;
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
  /**
   * Required for `skills-extension` reads: which skill's declared `resources`
   * set authorizes this URI. Naming the skill is what keeps the allowlist
   * per-skill instead of pooling every declared file on the server.
   */
  skillUri?: string;
  signal?: AbortSignal;
}

export interface McpResourceListRequest {
  source: "tool-cli";
  serverName: string;
  signal?: AbortSignal;
}

/** Minimum skill shape the policy needs; mirrors `McpSkillMetadata`. */
export interface McpPolicySkill {
  readonly name: string;
  readonly uri: string;
  readonly serverName: string;
  /**
   * The tool definitions this skill references, so activating it reveals their
   * schemas on the direct proxy surface.
   *
   * This list is an *exposure* set, never an authorization set. It decides
   * which schemas the model can read, and nothing else: it does not grant the
   * right to execute anything, and a tool absent from every skill is still
   * callable from every surface.
   */
  readonly referencedTools: readonly string[];
  /**
   * A digest over the exact content this reference covers, when the origin can
   * supply one (SEP-2640 servers can; the legacy `skill://` convention cannot).
   *
   * Folding it into the activation key is what keeps activation content-bound:
   * if a later listing rotates a digest, adds a file, or drops one, the key
   * changes, and the newly published definition set is what activates rather
   * than yesterday's. It decides *which definitions* are revealed, never
   * whether anything may run.
   */
  readonly contentFingerprint?: string;
}

/**
 * The result of activating a skill's tool-definition references.
 *
 * There is no declined or unavailable case, because no user decision is
 * involved: revealing a schema is a context-engineering act, not an execution
 * one. `reactivated` means this exact origin + content set had already been
 * activated this session, so the model has seen these definitions before.
 */
export interface SkillReferenceOutcome {
  readonly status: "activated" | "reactivated";
  /** Definitions actually revealed: names that resolve to a discovered tool. */
  readonly referencedTools: readonly string[];
  /**
   * Names the skill declared that no connected server serves.
   *
   * A catalogue defect on the server's side, reported so it is visible rather
   * than silently dropped. It is never passed to the host as an activated
   * name: there is no definition behind it to reveal, and the host expects
   * names it has already registered.
   */
  readonly unresolvedTools: readonly string[];
}

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
 * Every execution path — direct proxy tools, Code Mode dispatch, tool-cli
 * provider RPC, and skill resource reads — crosses this class exactly once per
 * operation. Discovery, argument validation, permission semantics, approval,
 * cancellation, and audit all happen here, and nothing reaches an MCP server
 * without passing through `callTool` / `readResource` below.
 *
 * Two things this class deliberately keeps apart:
 *
 * - **Exposure** — which tool *definitions* the direct proxy surface shows the
 *   model. Skills drive this, and only this. A deferred definition is a hidden
 *   schema, not a withheld capability, so exposure never refuses a call.
 * - **Authorization** — whether an operation may execute. Driven by the
 *   server's own per-tool annotations at dispatch time, identically for every
 *   source. Code Mode, tool-cli, and the proxy get the same answer.
 *
 * Resource reads are the one place origin binding *is* authorization: skill
 * content carries workflow instructions, so a `skill://` URI stays owned by the
 * server that advertised it and inaccessible through the shell bridge.
 */
export class McpPolicy {
  private readonly gateway: McpPolicyGateway;
  private readonly approvals: McpApprovalPrompt | undefined;
  private readonly auditLimit: number;
  private readonly onAudit: ((record: McpAuditRecord) => void) | undefined;

  /**
   * Tools whose direct proxy definition is deferred until a skill referencing
   * them is activated, mapped to the skills that reference them.
   *
   * Purely a context-visibility index. Nothing here is consulted when deciding
   * whether a call may execute.
   */
  private readonly deferredTools = new Map<string, Set<string>>();
  /** Tool definitions revealed by an activated skill reference. */
  private readonly referencedTools = new Set<string>();
  /** Activated skill reference keys, bound to server origin plus content. */
  private readonly activatedReferences = new Set<string>();
  /** Skill URIs registered per server origin, for `skill-load` authorization. */
  private readonly skillUrisByServer = new Map<string, Set<string>>();
  /** URIs a server itself listed in the current discovery pass. */
  private readonly discoveredUrisByServer = new Map<string, Set<string>>();
  /**
   * Per-skill SEP-2640 resource allowlists, keyed by `serverName\0skillUri`.
   *
   * A skill's declared `resources` set is the *only* thing that authorizes a
   * `skills-extension` read. Storing it per skill rather than per server means a
   * file listed by skill A cannot be read while "loading" skill B.
   */
  private readonly extensionResourceUris = new Map<string, Set<string>>();
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

  /**
   * Register discovered skills so the definitions they reference start deferred
   * on the direct proxy surface, and bind their URIs for `skill-load` reads.
   *
   * Registration changes what the model can *see*. It never changes what any
   * surface may call.
   */
  registerSkills(skills: readonly McpPolicySkill[]): void {
    for (const skill of skills) {
      for (const tool of skill.referencedTools) {
        let owners = this.deferredTools.get(tool);
        if (!owners) {
          owners = new Set<string>();
          this.deferredTools.set(tool, owners);
        }
        owners.add(skill.name);
      }

      let uris = this.skillUrisByServer.get(skill.serverName);
      if (!uris) {
        uris = new Set<string>();
        this.skillUrisByServer.set(skill.serverName, uris);
      }
      uris.add(skill.uri);
    }
  }

  /**
   * Bind a SEP-2640 skill's declared resource URIs so they become readable
   * under the `skills-extension` source — and nothing else does.
   *
   * The set replaces any previous one for that skill, so a rotated listing
   * narrows access immediately instead of accumulating stale grants.
   */
  registerSkillResources(
    serverName: string,
    skillUri: string,
    resourceUris: readonly string[],
  ): void {
    this.extensionResourceUris.set(
      extensionResourceKey(serverName, skillUri),
      new Set(resourceUris),
    );
  }

  /**
   * Tool definitions currently deferred on the direct proxy surface — declared
   * to the model API for grammar and dispatch, but with their schemas withheld
   * from the prompt until a skill references them.
   */
  getDeferredToolNames(): string[] {
    return [...this.deferredTools.keys()].filter((name) => !this.referencedTools.has(name)).sort();
  }

  /** Skills whose activation would reveal `toolName`'s schema. */
  getReferencingSkills(toolName: string): string[] {
    return [...(this.deferredTools.get(toolName) ?? [])].sort();
  }

  /**
   * True when a tool's direct proxy definition is still deferred.
   *
   * A visibility question only. Callers must not use it to decide whether a
   * call may proceed — `callTool` deliberately does not consult it.
   */
  isDeferred(toolName: string): boolean {
    return this.deferredTools.has(toolName) && !this.referencedTools.has(toolName);
  }

  reset(): void {
    this.deferredTools.clear();
    this.referencedTools.clear();
    this.activatedReferences.clear();
    this.skillUrisByServer.clear();
    this.discoveredUrisByServer.clear();
    this.extensionResourceUris.clear();
    this.audit.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Discovery (what every non-proxy surface may see)
  // ---------------------------------------------------------------------------

  getVisibleServers(): string[] {
    return this.gateway.getConnectedServers();
  }

  /**
   * Every discovered tool on a server.
   *
   * Code Mode and tool-cli discover independently of skills: their whole
   * purpose is the case where no skill fires, so filtering this by skill
   * references would make the investigative and reductive surfaces unusable in
   * exactly the sessions they exist for. Deferral shapes the *prompt*, not the
   * catalogue these surfaces read.
   */
  getDiscoverableTools(serverName: string): McpTool[] {
    return this.gateway.getToolsForServer(serverName);
  }

  // ---------------------------------------------------------------------------
  // Skill references (exposure activation)
  // ---------------------------------------------------------------------------

  /**
   * Activate a skill's tool-definition references.
   *
   * This reveals schemas; it grants nothing. There is no prompt, because
   * approval belongs at execution: the user is asked when a non-read-only tool
   * actually runs, whichever surface ran it, and asking here as well would both
   * charge for authority that was never conferred and put a human gate in the
   * one path designed to be zero-latency and cache-preserving.
   *
   * The activation key still covers server origin, skill URI, and a digest of
   * the exact referenced set, so a rotated listing is recognised as a distinct
   * activation rather than silently inheriting the previous one. That binding
   * decides *which definitions* are revealed — never whether anything may run.
   */
  activateSkillReference(skill: McpPolicySkill): SkillReferenceOutcome {
    // Only names that resolve to a real discovered tool are revealed. A skill
    // may name tools its server never exposed, or name one twice; the host
    // expects plain, already-registered names in activation order with no
    // duplicates, and an unknown name would be silently dropped downstream
    // anyway. Filtering here keeps `details` and the host's activation list
    // describing the same thing.
    const known = this.discoveredToolNames();
    const referenced: string[] = [];
    const unresolved: string[] = [];
    const seen = new Set<string>();
    for (const tool of skill.referencedTools) {
      if (seen.has(tool)) continue;
      seen.add(tool);
      if (known.has(tool)) referenced.push(tool);
      else unresolved.push(tool);
    }

    if (referenced.length === 0) {
      return { status: "activated", referencedTools: [], unresolvedTools: unresolved };
    }

    const key = skillReferenceKey(skill);
    const alreadyActivated = this.activatedReferences.has(key);
    this.activatedReferences.add(key);
    for (const tool of referenced) {
      this.referencedTools.add(tool);
    }

    this.record({
      source: "skill-load",
      operation: "skill-reference",
      serverName: skill.serverName,
      uri: skill.uri,
      decision: "allowed",
    });

    return {
      status: alreadyActivated ? "reactivated" : "activated",
      referencedTools: referenced,
      unresolvedTools: unresolved,
    };
  }

  /** Every tool name currently discoverable across all connected servers. */
  private discoveredToolNames(): Set<string> {
    const names = new Set<string>();
    for (const server of this.gateway.getConnectedServers()) {
      for (const tool of this.gateway.getToolsForServer(server)) {
        names.add(tool.name);
      }
    }
    return names;
  }

  // ---------------------------------------------------------------------------
  // Tool calls
  // ---------------------------------------------------------------------------

  /**
   * Authorize and dispatch a tool call. Every execution path funnels here, and
   * upstream is reached only after all checks below pass.
   *
   * Notably absent: any consultation of skill references. A deferred definition
   * is a hidden schema, not a withheld capability, so a tool no skill has
   * revealed is still callable — by the model whose grammar still contains it,
   * by a Code Mode script, and by tool-cli.
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
        ...(alternatives !== undefined ? { alternatives } : {}),
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

    // Permission semantics: the server's own annotations, at dispatch, for
    // every source alike. A read-only tool runs unasked; anything else asks the
    // user — including from line 47 of a running Code Mode script, which is
    // precisely the question routing through the harness makes askable.
    const readOnly = isReadOnlyToolCall(tool);
    let approval: McpApprovalOutcome | undefined;
    if (!readOnly) {
      const approved = await this.requestApproval({
        kind: "tool-call",
        source,
        serverName,
        toolName,
        title: `Run MCP tool "${toolName}"?`,
        message: formatToolApprovalMessage(source, serverName, tool, args),
        ...(signal !== undefined ? { signal } : {}),
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
      ...(approval !== undefined ? { approval } : {}),
    });
    return terminal;
  }

  // ---------------------------------------------------------------------------
  // Skills extension (draft SEP-2640)
  // ---------------------------------------------------------------------------

  /**
   * The server's declared settings for the draft skills extension, or
   * `undefined` when it did not declare it.
   *
   * Resolved fresh on every call. The extension is negotiated in `initialize`,
   * but a reconnect can change the answer, and caching "this server supports
   * skills" would let a stale yes outlive the negotiation that produced it.
   */
  getSkillsExtension(serverName: string): Record<string, unknown> | undefined {
    if (!this.gateway.getConnectedServers().includes(serverName)) return undefined;
    return this.gateway.getExtensionCapability(serverName, SKILLS_EXTENSION_NAME);
  }

  /** True when the server declared `directoryRead: true` on the extension. */
  supportsSkillDirectoryRead(serverName: string): boolean {
    return this.getSkillsExtension(serverName)?.["directoryRead"] === true;
  }

  /**
   * Draft SEP-2640 `skills/list`.
   *
   * Refused unless the server declared the extension: an undeclared method is
   * not a method this host is entitled to probe for.
   */
  async listMcpSkills(
    serverName: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<SkillsListResult> {
    this.assertSkillsExtension(serverName, "skill-list");
    if (signal?.aborted) {
      throw this.denyExtension(serverName, "skill-list", "cancelled", "skills/list was cancelled.");
    }
    const result = await this.gateway.requestSkillsList(serverName, cursor, signal);
    this.record({
      source: "skills-extension",
      operation: "skill-list",
      serverName,
      decision: "allowed",
    });
    return result;
  }

  /** Draft SEP-2640 `skills/get`. */
  async getMcpSkill(
    serverName: string,
    uri: string,
    signal?: AbortSignal,
  ): Promise<SkillsGetResult> {
    this.assertSkillsExtension(serverName, "skill-get", uri);
    if (signal?.aborted) {
      throw this.denyExtension(
        serverName,
        "skill-get",
        "cancelled",
        `skills/get for ${uri} was cancelled.`,
        uri,
      );
    }
    const result = await this.gateway.requestSkillsGet(serverName, uri, signal);
    this.record({
      source: "skills-extension",
      operation: "skill-get",
      serverName,
      uri,
      decision: "allowed",
    });
    return result;
  }

  /**
   * Draft SEP-2640 `resources/directory/read`.
   *
   * Refused when the server declared the extension without `directoryRead`.
   * The setting defaults to false, so silence means no.
   */
  async readSkillDirectory(
    serverName: string,
    uri: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<DirectoryReadResult> {
    this.assertSkillsExtension(serverName, "skill-directory", uri);

    if (!this.supportsSkillDirectoryRead(serverName)) {
      throw this.denyExtension(
        serverName,
        "skill-directory",
        "directory_read_unavailable",
        `MCP server "${serverName}" did not declare "directoryRead" on the skills extension, so ` +
          `${uri} cannot be enumerated.`,
        uri,
      );
    }

    if (signal?.aborted) {
      throw this.denyExtension(
        serverName,
        "skill-directory",
        "cancelled",
        `Directory read of ${uri} was cancelled.`,
        uri,
      );
    }

    const result = await this.gateway.requestDirectoryRead(serverName, uri, cursor, signal);
    this.record({
      source: "skills-extension",
      operation: "skill-directory",
      serverName,
      uri,
      decision: "allowed",
    });
    return result;
  }

  // ---------------------------------------------------------------------------
  // Resources
  // ---------------------------------------------------------------------------

  /**
   * List the resources visible to tool-cli.
   *
   * `skill://` is a separate authorization domain: those resources carry
   * workflow instructions and grants, so they remain reachable only through
   * skill discovery/load and can never be enumerated through the shell bridge.
   */
  async listResources(request: McpResourceListRequest): Promise<Resource[]> {
    const { source, serverName, signal } = request;
    const deny = (reason: McpPolicyDenialReason, message: string) => {
      this.record({
        source,
        operation: "resource-list",
        serverName,
        decision: "denied",
        reason,
      });
      return new McpPolicyError({ reason, message, source, serverName });
    };

    if (!this.gateway.getConnectedServers().includes(serverName)) {
      throw deny("server_not_connected", `MCP server "${serverName}" is not connected.`);
    }
    if (signal?.aborted) {
      throw deny("cancelled", `Listing resources on "${serverName}" was cancelled.`);
    }

    const resources = await this.gateway.listResources(serverName, signal);
    const visible = resources.filter(
      (resource) => !this.isSkillOwnedResource(serverName, resource.uri),
    );
    this.record({
      source,
      operation: "resource-list",
      serverName,
      decision: "allowed",
    });
    return visible;
  }

  /** List policy-visible resource templates for tool-cli. */
  async listResourceTemplates(request: McpResourceListRequest): Promise<ResourceTemplateType[]> {
    const { source, serverName, signal } = request;
    const deny = (reason: McpPolicyDenialReason, message: string) => {
      this.record({
        source,
        operation: "resource-templates",
        serverName,
        decision: "denied",
        reason,
      });
      return new McpPolicyError({ reason, message, source, serverName });
    };

    if (!this.gateway.getConnectedServers().includes(serverName)) {
      throw deny("server_not_connected", `MCP server "${serverName}" is not connected.`);
    }
    if (signal?.aborted) {
      throw deny("cancelled", `Listing resource templates on "${serverName}" was cancelled.`);
    }

    const templates = await this.gateway.listResourceTemplates(serverName, signal);
    const visible = templates.filter(
      (template) => !this.isSkillOwnedResource(serverName, template.uriTemplate),
    );
    this.record({
      source,
      operation: "resource-templates",
      serverName,
      decision: "allowed",
    });
    return visible;
  }

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

    if (signal?.aborted) {
      this.record({
        source: "skill-discovery",
        operation: "resource-list",
        serverName,
        decision: "denied",
        reason: "cancelled",
      });
      throw new McpPolicyError({
        reason: "cancelled",
        message: `Listing skill resources on "${serverName}" was cancelled.`,
        source: "skill-discovery",
        serverName,
      });
    }

    const resources = await this.gateway.listResources(serverName, signal);
    const skillResources = resources.filter(isSkillResourceUri);
    this.discoveredUrisByServer.set(serverName, new Set(skillResources.map((r) => r.uri)));
    this.record({
      source: "skill-discovery",
      operation: "resource-list",
      serverName,
      decision: "allowed",
    });
    return skillResources;
  }

  /**
   * Authorize and dispatch a resource read using the same policy discipline as
   * tool calls: origin binding, discovery, cancellation, and audit.
   */
  async readResource(request: McpResourceReadRequest): Promise<ReadResourceResult> {
    const { source, serverName, uri, skillUri, signal } = request;

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

    // The legacy convention recognises skills by URI shape, so the shape is the
    // outer bound of what it may read. SEP-2640 reads are authorized by exact
    // membership in a skill's declared `resources` set — strictly narrower — so
    // they do not need, and must not be limited by, a scheme heuristic.
    if (source === "tool-cli" && this.isSkillOwnedResource(serverName, uri)) {
      throw deny(
        "resource_not_discovered",
        `Resource ${uri} belongs to the skill authorization surface and cannot be read through tool-cli. Use load_skill instead.`,
      );
    }

    if (source !== "skills-extension" && source !== "tool-cli" && !hasSkillScheme(uri)) {
      throw deny(
        "resource_not_discovered",
        `Resource ${uri} is outside the skill resource surface this host authorizes.`,
      );
    }

    if (source === "skills-extension") {
      if (!skillUri) {
        throw deny(
          "resource_not_discovered",
          `Read of ${uri} did not name the skill whose declared resources authorize it.`,
        );
      }
      if (!this.getSkillsExtension(serverName)) {
        throw deny(
          "extension_not_declared",
          `MCP server "${serverName}" does not declare the skills extension, so ${uri} cannot be read under it.`,
        );
      }
    }

    const allowed =
      source === "tool-cli" ? undefined : this.allowedReadUris(source, serverName, skillUri);

    if (allowed !== undefined && !allowed.has(uri)) {
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
        source === "skills-extension"
          ? `Resource ${uri} is not listed in the resources of skill ${skillUri ?? "(unknown)"} on MCP server "${serverName}".`
          : `Resource ${uri} was not discovered as a skill on MCP server "${serverName}".`,
      );
    }

    if (signal?.aborted) {
      throw deny("cancelled", `Read of ${uri} was cancelled before dispatch.`);
    }

    const result = await this.gateway.readResource(serverName, uri, signal);
    if (source === "tool-cli") {
      const hidden = result.contents.find((content) =>
        this.isSkillOwnedResource(serverName, content.uri),
      );
      if (hidden !== undefined) {
        throw deny(
          "resource_not_discovered",
          `MCP server "${serverName}" returned skill-owned resource ${hidden.uri} while reading ${uri}; the entire response was refused. Use load_skill for skill resources.`,
        );
      }
    }
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

  private allowedReadUris(
    source: Exclude<McpResourceSource, "tool-cli">,
    serverName: string,
    skillUri: string | undefined,
  ): Set<string> {
    if (source === "skills-extension") {
      if (!skillUri) return new Set<string>();
      return (
        this.extensionResourceUris.get(extensionResourceKey(serverName, skillUri)) ??
        new Set<string>()
      );
    }
    if (source === "skill-discovery") {
      return this.discoveredUrisByServer.get(serverName) ?? new Set<string>();
    }
    return this.skillUrisByServer.get(serverName) ?? new Set<string>();
  }

  private isSkillOwnedResource(serverName: string, uri: string): boolean {
    if (hasSkillScheme(uri) || this.skillUrisByServer.get(serverName)?.has(uri) === true) {
      return true;
    }
    for (const [key, resourceUris] of this.extensionResourceUris) {
      const owner = key.slice(0, key.indexOf(NUL));
      if (owner === serverName && resourceUris.has(uri)) return true;
    }
    return false;
  }

  private findOtherOrigin(
    uri: string,
    serverName: string,
    source: McpResourceSource,
  ): string | undefined {
    if (source === "tool-cli") return undefined;
    if (source === "skills-extension") {
      // Extension allowlists are keyed by `serverName\0skillUri`, so a match on
      // another origin is what turns "not listed here" into "listed elsewhere".
      for (const [key, uris] of this.extensionResourceUris) {
        const owner = key.slice(0, key.indexOf(NUL));
        if (owner !== serverName && uris.has(uri)) return owner;
      }
      return undefined;
    }
    const index =
      source === "skill-discovery" ? this.discoveredUrisByServer : this.skillUrisByServer;
    for (const [candidate, uris] of index) {
      if (candidate !== serverName && uris.has(uri)) return candidate;
    }
    return undefined;
  }

  /**
   * Refuse an extension method unless the server is connected and declared the
   * extension. Records the denial before throwing, like every other refusal.
   */
  private assertSkillsExtension(
    serverName: string,
    operation: "skill-list" | "skill-get" | "skill-directory",
    uri?: string,
  ): void {
    if (!this.gateway.getConnectedServers().includes(serverName)) {
      throw this.denyExtension(
        serverName,
        operation,
        "server_not_connected",
        `MCP server "${serverName}" is not connected.`,
        uri,
      );
    }
    if (!this.gateway.getExtensionCapability(serverName, SKILLS_EXTENSION_NAME)) {
      throw this.denyExtension(
        serverName,
        operation,
        "extension_not_declared",
        `MCP server "${serverName}" does not declare the "${SKILLS_EXTENSION_NAME}" extension, so ` +
          `its skills methods are not available.`,
        uri,
      );
    }
  }

  private denyExtension(
    serverName: string,
    operation: "skill-list" | "skill-get" | "skill-directory",
    reason: McpPolicyDenialReason,
    message: string,
    uri?: string,
  ): McpPolicyError {
    this.record({
      source: "skills-extension",
      operation,
      serverName,
      ...(uri !== undefined ? { uri } : {}),
      decision: "denied",
      reason,
    });
    return new McpPolicyError({
      reason,
      message,
      source: "skills-extension",
      serverName,
      ...(uri !== undefined ? { uri } : {}),
    });
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
  return hasSkillScheme(resource.uri) && resource.uri.endsWith("/SKILL.md");
}

function hasSkillScheme(uri: string): boolean {
  return uri.slice(0, "skill://".length).toLowerCase() === "skill://";
}

function extensionResourceKey(serverName: string, skillUri: string): string {
  return `${serverName}${NUL}${skillUri}`;
}

function skillReferenceKey(skill: McpPolicySkill): string {
  const tools = [...skill.referencedTools].sort().join(" ");
  const digest = createHash("sha256").update(tools).digest("hex").slice(0, 32);
  // The fingerprint participates in the key so a rotated resource set is a
  // distinct activation rather than a silent reuse of the previous definitions.
  // Legacy skills have none; they degrade to the origin+URI+tools key.
  return [skill.serverName, skill.uri, digest, skill.contentFingerprint ?? ""].join(NUL);
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
