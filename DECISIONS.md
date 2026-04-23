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
