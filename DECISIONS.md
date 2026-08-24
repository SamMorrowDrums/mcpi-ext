# Decision Log

Record of key architectural and design decisions. Keep this up to date as decisions are made.

## 001 — Extension, not fork

**Date:** 2026-04-23
**Context:** Should we fork pi to build the MCP agent harness, or use the extension API?
**Decision:** Build as a pi extension. The extension API provides everything we need: `registerTool()`, `setActiveTools()`, `on("tool_result", ...)`, `exec()`, lifecycle hooks.
**Rationale:** Everything in scope (skill-gated tool visibility, football CLI, code mode, output offloading) is policy and orchestration — deciding _when_ and _how_ to expose MCP tools to the model. That's extension territory. We'd only need to fork if we needed to change pi's tool dispatch, context assembly, or model loop.

## 002 — Agent harness controls tool visibility, not MCP servers

**Date:** 2026-04-23
**Context:** How do MCP tools become visible to the model?
**Decision:** The harness (pi extension) decides what tools the model sees. MCP servers just expose their tools and optionally their skills. The harness holds all discovered tools internally and only sends them to the model when a skill names them.
**Rationale:** Maximal agent capability, minimal tokens. The model's context window isn't stuffed with every tool from every connected MCP server. Tools appear only when a skill provides the context for using them.

## 003 — Tiered access model

**Date:** 2026-04-23
**Context:** How should the model access MCP tools?
**Decision:** Three tiers of access, all complementary:

| Tier               | Mechanism                                                    | When Used                               |
| ------------------ | ------------------------------------------------------------ | --------------------------------------- |
| 1 — Skills (#1)    | Skill loaded → `allowed-tools` exact-matched → tools visible | MCP server ships skills                 |
| 2 — Football (#2)  | CLI progressive discovery → HITL for writes                  | Ad-hoc exploration, no skills           |
| 3 — Code Mode (#4) | all-tool discovery + read-only dispatch                      | Sandboxed computation and safe batching |

**Rationale:** Different situations call for different access patterns. Skills give direct access with workflow knowledge. Football gives interactive access with safety. Code mode gives autonomous access to safe operations at scale.

## 004 — Large tool output offloading

**Date:** 2026-04-23
**Context:** Tool responses can be thousands of tokens, wasting context window.
**Decision:** Intercept tool results via `pi.on("tool_result", ...)`. If output exceeds ~500 tokens, write to a file and return a pointer to the model.
**Rationale:** Controls output token cost the same way skills/football/code-mode control input token cost. The model can read the file if it needs the content.

## 005 — MCP SDK and JSON config for server connections

**Date:** 2026-04-23
**Context:** How should the extension connect to MCP servers?
**Decision:** Use the official TypeScript MCP packages with a JSON config file at `~/.config/mcpi-ext/mcp.json` (overridable via `--mcp-config` flag). The current client implementation uses the split `@modelcontextprotocol/client` package; server fixtures use `@modelcontextprotocol/server`. The config supports two transport types: `stdio` (spawns a child process) and `remote` (Streamable HTTP). A `McpClientManager` class connects to all configured servers on `session_start`, discovers tools via `tools/list`, handles tool-list changes, and disconnects on `session_shutdown`.
**Rationale:** The official MCP SDK is the canonical way to implement MCP clients. JSON config aligns with VS Code and Claude Code conventions for MCP server configuration. Supporting both stdio and remote covers local dev servers and cloud-hosted MCP endpoints. Tools are discovered and stored internally but NOT registered with pi — the access tiers (Skills #1, Football #2, Code Mode #4) decide when to expose tools to the model.

## 006 — CI model access via GITHUB_TOKEN

**Date:** 2026-04-23
**Context:** Can Pi's `github-copilot` provider use the Actions `GITHUB_TOKEN` for model inference in CI?
**Decision:** Yes. The GitHub Models API (GA since April 2025) grants model inference to the Actions `GITHUB_TOKEN` when the workflow declares `permissions: models: read`. Pi's `--provider github-copilot` uses this same API. The CI workflow declares this permission so future e2e tests can run Pi with model access without a PAT.
**Rationale:** Using the built-in `GITHUB_TOKEN` avoids storing secrets for CI model access. The `models: read` scope is the minimum required — no write access needed. This enables full trajectory e2e tests in CI (connect to MCP servers, run Pi agent, verify results).

## 007 — Custom skill registry for MCP skills, not Pi's native skill system

**Date:** 2026-04-23
**Context:** Should MCP-discovered skills use Pi's built-in `loadSkills`/`formatSkillsForPrompt` pipeline (writing SKILL.md files to disk) or a custom in-extension registry?
**Decision:** Custom `SkillRegistry` + `load_skill` tool + `formatMcpSkillsForPrompt`, styled after Pi's native skill system but fully self-contained in the extension. Skills are discovered from MCP `skill://` resources and injected into the system prompt via the `before_agent_start` hook.
**Rationale:** MCP skills live on remote servers, not on disk. Writing them to temp files would be fragile and unnecessary. The custom approach keeps MCP skills self-contained, gives us full control over the activation → tool gating flow, and avoids coupling to Pi's internal skill loader. The XML format matches Pi's `<available_skills>` pattern so models already know how to interact with it.

## 008 — Cache-safe progressive tool disclosure via `deferred` flag

**Date:** 2026-05-11
**Context:** When `load_skill` called `setActiveTools()` to reveal new tools, the tools array sent to the model changed, invalidating prompt cache. Decision 008 previously accepted this trade-off.
**Decision:** Use `deferred: true` on MCP tool proxies with provider-native support and extension-level gating:

1. **Anthropic:** pi-mono maps `deferred: true` to `defer_loading: true` in the API payload. Deferred tools stay in the tools array but are hidden from the model's view. Optional `tool_reference` content blocks can explicitly enable them on demand.
2. **OpenAI Responses:** pi-mono maps `deferred: true` to `defer_loading: true` and auto-injects `{"type": "tool_search"}` into the tools array. The model discovers deferred tools automatically via hosted server-side search — no explicit activation needed. (OpenAI's client-executed `tool_search_output` is the equivalent of Anthropic's `tool_reference`, but hosted search is sufficient for our use case.)
3. **All providers (fallback):** The extension's `tool_call` hook blocks premature calls to gated tools and returns an error message naming the relevant skill. After `load_skill` fires, tools are marked as enabled and calls go through.

**Rationale:** Both Anthropic and OpenAI natively support `defer_loading` (tested with Claude Opus 4.7 and GPT-5.4). The tools array and system prompt stay constant throughout the conversation — prompt cache is fully preserved. The `tool_call` hook provides a provider-agnostic enforcement layer for providers without native `defer_loading` support.

## 009 — tool-cli uses JSON-RPC 2.0 over HTTP on a predefined port

**Date:** 2026-04-24
**Context:** The Football CLI (issue #2) needs a communication protocol between the thin CLI binary and the extension that manages MCP connections.
**Decision:** JSON-RPC 2.0 over HTTP on `localhost:7179` (overridable via `TOOL_CLI_PORT` env var). The RPC server lives in the extension, started on `session_start` and stopped on `session_shutdown`. The CLI binary (`tool-cli`) is a thin client that uses `fetch` to call the server. No new dependencies — uses Node's `http` module for the server and global `fetch` for the client.
**Rationale:** JSON-RPC 2.0 is a standard, simple protocol that maps cleanly to the four operations needed (listServers, listTools, describeTool, callTool). HTTP is the simplest transport for request/response. A predefined port avoids coordination complexity for now. The architecture supports future HITL confirmation for non-read-only tools — the RPC server's `callTool` method is the single choke point where tool annotations can be checked and destructive calls gated through user approval.

> **Superseded in part by [015](#015--mcppolicy-is-the-single-authorization-boundary-for-every-mcp-execution-path).** The RPC server's `callTool` is not a sufficient choke point: it forwards `server`/`tool`/`args` to the provider without checking them against the discovered set, so a caller can name a tool the CLI never advertised. Authorization now lives in `McpPolicy`, behind the provider.

## 010 — tool-cli has no auth (known limitation)

**Date:** 2026-04-24
**Context:** The tool-cli RPC server listens on `127.0.0.1:7179` with no authentication. Any local process can discover and execute MCP tools through it.
**Decision:** Accept this for now as a development convenience. The server is localhost-only, which limits the blast radius to local processes, but this is not a finished security posture. Before production use, add a shared secret (e.g. a one-time token passed via environment variable from the extension to the CLI) so only the intended agent process can make calls.
**Rationale:** Adding auth now would complicate the initial implementation without changing the threat model much — the agent already has shell access and could call MCP tools through other means. But as the tool matures and especially once HITL gating is added for destructive tools, unauthenticated access would let other local processes bypass those safety checks. Auth is a prerequisite for trustworthy HITL.

> **Superseded.** `@sammorrowdrums/tool-cli` now binds a random port and issues a 32-byte session token; requests without `Authorization: Bearer <token>` are rejected. Authentication alone is not sufficient for trustworthy HITL, though — see [015](#015--mcppolicy-is-the-single-authorization-boundary-for-every-mcp-execution-path): an authenticated caller must still be re-authorized against the discovered, ungated tool set.

## 011 — Code mode uses `isolated-vm` for sandbox execution

**Date:** 2026-04-24
**Context:** Code mode (#4) lets the model write JavaScript to chain read-only MCP tool calls. The generated code runs in a sandbox. Options evaluated: Node `vm` module, `isolated-vm`, Deno subprocess, Cloudflare workerd, Pydantic/Python subprocess, WASM.
**Decision:** Use `isolated-vm` (V8 isolates in Node.js). Provides memory limits (128MB default), CPU timeouts (30s default), and V8-level isolation. Tool dispatch via `Reference` async callbacks — actual MCP calls execute on the host, never in the sandbox.
**Rationale:** Code mode has no HITL prompt (human-in-the-loop) because `McpPolicy` refuses any non-read-only tool from the `code-mode` source outright rather than asking — making sandbox security important. Node's `vm` module is documented as "not a security mechanism" and is escapable via prototype pollution. `isolated-vm` provides genuine V8-level isolation with ~15ms overhead — negligible vs MCP network I/O. Deno subprocess (400ms/call) and workerd are too slow or complex for interactive use.

## 012 — Code mode uses `ctx.eval` instead of `compileModule` for execution

**Date:** 2026-04-24
**Context:** Initial implementation used `isolate.compileModule()` + `module.evaluate()` for running sandboxed code with top-level await. Discovery: `module.evaluate()` resolves prematurely when multiple sequential `Reference.apply()` calls use `{ result: { promise: true } }` — the module evaluation promise resolves after the first async reference call, not after all code completes.
**Decision:** Use `ctx.eval()` with `{ promise: true, copy: true }` instead. Wrap user code in an async IIFE that returns the final result.
**Rationale:** `ctx.eval` with `promise: true` correctly awaits the full async IIFE, including all sequential tool dispatch calls. This is critical for code mode's chaining use case where the model writes for-loops calling multiple tools sequentially.

## 013 — Centralize MCP v2 negotiation, input, and terminal results

**Date:** 2026-08-24
**Context:** The monolithic MCP SDK v1 client could not provide negotiated 2026-era behavior, SDK-managed multi-round-trip input, or one lossless result contract across direct tools, Code Mode, and tool-cli.
**Decision:** Build every connection through one `@modelcontextprotocol/client@2.0.0` factory using automatic version negotiation, the public Streamable HTTP and stdio transports, and explicit `2026-07-28` support with legacy fallback. The seam advertises only form elicitation and an empty extensions declaration, bounds MRTR rounds and request time, and routes form input through mcpi's explicit UI. Every tool path receives one terminal `CallToolResult` adapter; protocol and transport failures remain thrown errors. Missing cache TTLs default to zero, and only SDK-managed tool-list change subscriptions are enabled.
**Rationale:** A single seam keeps identity, capabilities, negotiation diagnostics, pagination, timeout policy, and user-input safety consistent. Preserving the protocol result object prevents each execution path from dropping newer content blocks or scalar structured JSON. Immediately stale cache defaults avoid surprising reuse, while servers can still opt in with explicit cache hints. General subscription lifecycle and persistent cache ownership remain future host-level work.

## 014 — Code Mode separates discovery, schema survival, and dispatch permission

**Date:** 2026-08-24
**Context:** Code Mode registration and discovery were both gated by `readOnlyHint === true && outputSchema`, which disabled pure computation with zero MCP tools, hid non-read-only tools from discovery, and excluded safe legacy tools that omitted an output schema.
**Decision:** Register `code_execute` and `code_search` independently of MCP connectivity. Catalog every MCP tool and generate hints for all of them, but allow host dispatch only for tools with `readOnlyHint === true` and `destructiveHint !== true`. For callable tools lacking `outputSchema`, use a client-internal permissive schema with separate synthesized provenance; preserve declared schemas by reference and never add provenance to MCP traffic. Report declared/synthesized counts in diagnostics and hint headers. Refuse zero-callable `code_search` before isolate creation with `no_eligible_tools`, while keeping `code_execute` available for pure computation.
**Rationale:** Visibility is not authority. Keeping permission enforcement at the host dispatch boundary prevents generated code from invoking writes while still making the complete catalog understandable. The internal schema floor improves compatibility without pretending an unknown result is typed, and always-on execution preserves Code Mode's deterministic computation value even when MCP is unavailable.

## 015 — `McpPolicy` is the single authorization boundary for every MCP execution path

**Date:** 2026-08-24
**Context:** Four execution paths reached MCP independently: deferred/direct proxy tools, Code Mode dispatch, the tool-cli provider RPC, and skill resource reads. Each enforced a different subset of rules. `McpClientManager.callTool` verified only that a server was connected, never that the tool had been discovered. The tool-cli `ToolProvider` advertised every tool including skill-gated ones, and `ToolCliServer.callTool` forwards `server`/`tool`/`args` to the provider without a membership check, so an authenticated caller could name a hidden tool directly — the `tool_call` hook that gates mcpi dispatch never fires for RPC. `load_skill` unlocked an MCP server's `allowed-tools` with no user approval at all. Resource reads went straight to `client.readResource` with no origin isolation, so one server could serve another's `skill://` URI. Nothing recorded who initiated a call.
**Decision:** Introduce `McpPolicy` as the one dispatcher every path crosses exactly once. It owns connectivity checks, discovered-set membership, skill gating, argument validation against the declared input schema, annotation-driven HITL, cancellation checks, resource authorization, and an audit ring buffer. Each entry point tags its `source` (`proxy`, `code-mode`, `tool-cli`, `skill-discovery`, `skill-load`) and the policy applies the same ordered pipeline to all of them, denying before any upstream call. `createPolicyToolProvider` narrows tool-cli's view to the policy-visible set and re-authorizes each RPC call. MCP-origin skill grants require explicit user approval, keyed on server + resource URI + a hash of the sorted tool list, so widening `allowed-tools` or replaying a grant from another server re-prompts. A tool already unlocked by an approved grant is recorded as `reused` rather than prompted twice. Code Mode keeps its stricter rule: non-read-only tools are refused outright rather than confirmed.
**Rationale:** Enforcement duplicated across four call sites is enforcement that drifts; each path had already drifted. Collapsing to one boundary makes "unknown tools never reach upstream" and "HITL happens once" properties of the system rather than conventions. Denying before the provider call is what makes the tool-cli membership gap unexploitable without waiting on an upstream API change. Binding grants to origin and content means an approval authorizes a specific claim from a specific server, not a name. Recording source on every decision gives the audit log the one field it needs to be useful, and the `reused` outcome keeps a correct policy from degrading into prompt fatigue.

## 016 — Consume the draft skills extension behind a gate, verify every byte, and never mix contracts

**Date:** 2026-08-24
**Context:** Skill discovery relied on `skill://` resource URIs. A URI shape is not evidence: nothing proved that the SKILL.md a server returned at load time was the one whose frontmatter the host had shown the user at approval time, that a supporting file belonged to the skill being loaded, or that a server had not quietly rotated its content after approval. [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) proposes `skills/list`, `skills/get`, and `resources/directory/read` with per-resource `{uri, digest, size}` declarations that make those questions answerable — but it is an unratified Draft on the Extensions Track whose wire format can still change, and `github/github-mcp-server` declares the extension name today while implementing none of its methods.
**Decision:** Implement the extension as a client pinned to revision `753b9f2be43e07fdd070e535d75f190cff14beea`, gated behind `experimental.skillsExtension` (or `--mcp-skills-extension`) and **off by default**, with a startup diagnostic naming the revision and status so draft support can never be mistaken for final support. Advertise the capability per request under SEP-2133 and re-resolve it from the server's declared capabilities immediately before every call — cache listing contents, never the right to ask. Verify size and raw SHA-256 on every read with no already-verified shortcut and no API that returns unverified bytes; enforce the 512-entry and 16 MiB limits from the entry alone before fetching; reject malformed or uppercase digests rather than normalizing them; reparse SKILL.md frontmatter and compare it field-by-field against the listing. Key read allowlists by `serverName` + `skillUri` so a file listed by one skill cannot be read while loading another and no skill can cause a read against a different server. Extend the `McpPolicy` grant key with a fingerprint of the resource set so rotation re-prompts, and rebuild `allowed-tools` at load time from the entry just served. Resolve names in a per-origin namespace, recording collisions instead of shadowing. Honour `ttlMs`/`cacheScope` conservatively — `session` and `connection` only, page 1 only, five-minute cap, never for truncated listings, never for `skills/get`. Keep legacy `skill://` discovery as a documented compatibility fallback used only when a server declares no extension; once a server declares it, serve that server from the extension path alone, including when the listing is empty and when the extension path throws.
**Rationale:** A pinned revision and a default-off gate are what let an unratified proposal be implemented honestly — the alternative is shipping something that reads as support for a spec that does not exist yet. Verifying on every read rather than once is the difference between checking a claim and trusting a name: the failure this protects against is a server that serves different bytes the second time, which any cached verdict would miss. The frontmatter reparse closes the same gap for the field the user actually read before approving. Per-skill allowlists narrow authority to what an entry declared, where a per-server index would grant a skill everything the server ever listed. Binding approval to a content fingerprint means the user approved a specific set of claims, not a name a server can later refill. And treating an empty listing as a fallback trigger would let any extension-declaring server silently downgrade the host to the weaker contract — the one case where mixing contracts is most attractive to an attacker and least visible to the user.

## 017 — One always-emitted execution-routing section describing facilities by task shape, never precedence

**Date:** 2026-08-24
**Context:** The extension told the model _how_ to use each mechanism but never _when to reach for which_, and the little cross-tier guidance that existed was wrong in two ways. `CodeModeManager`'s prompt appendix carried a `### Choosing the right approach` block comparing all three tiers — cross-facility policy owned by one facility's module. `tool-cli`'s section instructed the model to "prefer the skill", a fixed precedence that is false whenever no skill matches the task. Both were emitted only when MCP servers happened to be connected, so a session with zero servers received no routing guidance at all despite `code_execute` being fully usable for pure computation. Nothing mentioned bash, even though the only facility that can write a file is bash. Availability was communicated by silence: an unstarted tool-cli simply produced no section, which the model cannot distinguish from a facility it forgot about. The prompt tag `<tool_cli>` read like an action, and models responded accordingly — emitting `<tool_cli>…</tool_cli>` pseudo-calls and fabricated transcripts instead of invoking the bash tool.
**Decision:** Add `src/routing/` as the single owner of cross-facility guidance. It emits exactly one `<execution_routing>` section on every load, **including with zero MCP servers**, describing four facilities — Skills (domain workflow guidance), Code Mode (sandboxed exact computation and control flow, no fs/net/process), tool-cli (authenticated MCP-to-shell on-ramp invoked _through the host bash tool_), and bash + external programs (the filesystem/artifact/data-pipeline substrate) — each by task shape, with an explicit note that tool-cli and bash compose. `FACILITY_ORDER` is alphabetical by id, chosen precisely because alphabetical cannot be read as a ranking and renders byte-stable across turns. Every facility always reports `available` / `unavailable` / `unknown` with a non-empty reason: code mode is available with zero servers; skills report discovered count and draft-extension status; tool-cli is advertised only after its RPC server actually starts, and a startup failure is surfaced with a next step; bash comes from host tool registration via `getAllTools()`, with `unknown` reserved for "the registry could not be read" rather than conflated with absent. A started tool-cli with no bash tool renders unavailable — the one cross-facility coupling, because a healthy RPC server is unusable without a shell. The cross-tier block is deleted from `CodeModeManager`, `prefer the skill` is deleted from tool-cli's section, and every mechanism description including `load_skill`'s tool description now leads with `Use when`, with skills stating that declared tools are enabled only after approval. `<tool_cli>` is renamed `<tool_cli_usage_docs>` and states outright that the model must invoke the bash tool with a `tool-cli ...` command and must never emit XML/text pseudo-calls or fabricate output. `src/routing/seam.ts` feature-detects a future core `registerExecutionFacility` via an `in` check plus `typeof`, with no assertions, and otherwise emits the complete section from `before_agent_start`; the paths are mutually exclusive so the section is never duplicated. `src/routing/tripwire.ts` ships `detectToolCliTripwires` as a regression guard for pseudo-calls and narrated transcripts with no real bash call.
**Rationale:** Routing guidance that only appears when servers connect teaches the model that computation requires a server, which is false — the zero-server case is exactly when a model most needs to be told `code_execute` still works. Precedence rules are the wrong shape for this problem: "prefer the skill" is correct only when a matching skill exists, and a model that internalises it wastes turns looking for one. Task shape degrades gracefully where ranking does not. Silence about an unavailable facility is indistinguishable from an incomplete prompt, so an explicit unavailable line with a reason is strictly more information than omission — and for a tool-cli that failed to start, the reason is the only way the user learns something broke. Alphabetical ordering is a deliberate anti-affordance: any semantic order invites the model to read position as priority. Keeping cross-facility prose out of `CodeModeManager` matters because a facility describing its rivals will describe them from its own point of view, and the appendix is loaded exactly when Code Mode is in play. The tag rename is the cheapest available fix for a real observed failure mode — an action-shaped tag is an invitation, and `<tool_cli_usage_docs>` reads as reference material about a program, which is what it is. Building the seam now while implementing none of the core API keeps this change additive: if `registerExecutionFacility` lands, the fallback stops firing with no edit here.
