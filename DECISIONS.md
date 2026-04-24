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

| Tier               | Mechanism                                                    | When Used                              |
| ------------------ | ------------------------------------------------------------ | -------------------------------------- |
| 1 — Skills (#1)    | Skill loaded → `allowed-tools` exact-matched → tools visible | MCP server ships skills                |
| 2 — Football (#2)  | CLI progressive discovery → HITL for writes                  | Ad-hoc exploration, no skills          |
| 3 — Code Mode (#4) | search+execute → no HITL                                     | Read-only tools with structured output |

**Rationale:** Different situations call for different access patterns. Skills give direct access with workflow knowledge. Football gives interactive access with safety. Code mode gives autonomous access to safe operations at scale.

## 004 — Large tool output offloading

**Date:** 2026-04-23
**Context:** Tool responses can be thousands of tokens, wasting context window.
**Decision:** Intercept tool results via `pi.on("tool_result", ...)`. If output exceeds ~500 tokens, write to a file and return a pointer to the model.
**Rationale:** Controls output token cost the same way skills/football/code-mode control input token cost. The model can read the file if it needs the content.

## 005 — MCP SDK and JSON config for server connections

**Date:** 2026-04-23
**Context:** How should the extension connect to MCP servers?
**Decision:** Use `@modelcontextprotocol/sdk` (TypeScript MCP SDK) with a JSON config file at `~/.config/pi-mcp-agent/mcp.json` (overridable via `--mcp-config` flag). The config supports two transport types: `stdio` (spawns a child process) and `remote` (Streamable HTTP). A `McpClientManager` class connects to all configured servers on `session_start`, discovers tools via `tools/list`, handles `notifications/tools/list_changed`, and disconnects on `session_shutdown`.
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

## 008 — Skill-gated tools accept prompt cache invalidation as a trade-off

**Date:** 2026-04-24
**Context:** When `load_skill` calls `setActiveTools()` to reveal new tools, the tool list sent to the model changes. This invalidates the prompt cache for subsequent turns because the system prompt + tool definitions are part of the cache key. With 38 tools on a server like GitHub MCP, hiding and revealing tools mid-conversation changes the cache signature.
**Decision:** Accept the cache invalidation. Progressive disclosure is worth it. The alternative — sending all tools from the start — stuffs the model's context with tool definitions it doesn't need yet, which is worse than a cache miss.
**Rationale:** The token cost of sending all tools upfront (38 tools × ~80 tokens each ≈ 3k tokens per turn) exceeds the one-time cache miss cost when tools are revealed. Skills also provide workflow instructions that make tool usage more reliable, which wouldn't happen if tools were just dumped into the context. For servers with many tools, a tool search/discovery flow (Football #2) can further reduce the impact by letting the model search for tools without revealing all of them.

## 009 — tool-cli uses JSON-RPC 2.0 over HTTP on a predefined port

**Date:** 2026-04-24
**Context:** The Football CLI (issue #2) needs a communication protocol between the thin CLI binary and the extension that manages MCP connections.
**Decision:** JSON-RPC 2.0 over HTTP on `localhost:7179` (overridable via `TOOL_CLI_PORT` env var). The RPC server lives in the extension, started on `session_start` and stopped on `session_shutdown`. The CLI binary (`tool-cli`) is a thin client that uses `fetch` to call the server. No new dependencies — uses Node's `http` module for the server and global `fetch` for the client.
**Rationale:** JSON-RPC 2.0 is a standard, simple protocol that maps cleanly to the four operations needed (listServers, listTools, describeTool, callTool). HTTP is the simplest transport for request/response. A predefined port avoids coordination complexity for now. The architecture supports future HITL confirmation for non-read-only tools — the RPC server's `callTool` method is the single choke point where tool annotations can be checked and destructive calls gated through user approval.

## 010 — tool-cli has no auth (known limitation)

**Date:** 2026-04-24
**Context:** The tool-cli RPC server listens on `127.0.0.1:7179` with no authentication. Any local process can discover and execute MCP tools through it.
**Decision:** Accept this for now as a development convenience. The server is localhost-only, which limits the blast radius to local processes, but this is not a finished security posture. Before production use, add a shared secret (e.g. a one-time token passed via environment variable from the extension to the CLI) so only the intended agent process can make calls.
**Rationale:** Adding auth now would complicate the initial implementation without changing the threat model much — the agent already has shell access and could call MCP tools through other means. But as the tool matures and especially once HITL gating is added for destructive tools, unauthenticated access would let other local processes bypass those safety checks. Auth is a prerequisite for trustworthy HITL.

## 011 — Code mode uses `isolated-vm` for sandbox execution

**Date:** 2026-04-24
**Context:** Code mode (#4) lets the model write JavaScript to chain read-only MCP tool calls. The generated code runs in a sandbox. Options evaluated: Node `vm` module, `isolated-vm`, Deno subprocess, Cloudflare workerd, Pydantic/Python subprocess, WASM.
**Decision:** Use `isolated-vm` (V8 isolates in Node.js). Provides memory limits (128MB default), CPU timeouts (30s default), and V8-level isolation. Tool dispatch via `Reference` async callbacks — actual MCP calls execute on the host, never in the sandbox.
**Rationale:** Code mode has no HITL (human-in-the-loop) since all tools are read-only, making sandbox security important. Node's `vm` module is documented as "not a security mechanism" and is escapable via prototype pollution. `isolated-vm` provides genuine V8-level isolation with ~15ms overhead — negligible vs MCP network I/O. Deno subprocess (400ms/call) and workerd are too slow or complex for interactive use.

## 012 — Code mode uses `ctx.eval` instead of `compileModule` for execution

**Date:** 2026-04-24
**Context:** Initial implementation used `isolate.compileModule()` + `module.evaluate()` for running sandboxed code with top-level await. Discovery: `module.evaluate()` resolves prematurely when multiple sequential `Reference.apply()` calls use `{ result: { promise: true } }` — the module evaluation promise resolves after the first async reference call, not after all code completes.
**Decision:** Use `ctx.eval()` with `{ promise: true, copy: true }` instead. Wrap user code in an async IIFE that returns the final result.
**Rationale:** `ctx.eval` with `promise: true` correctly awaits the full async IIFE, including all sequential tool dispatch calls. This is critical for code mode's chaining use case where the model writes for-loops calling multiple tools sequentially.
