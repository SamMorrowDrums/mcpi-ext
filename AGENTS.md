# AGENTS.md

## Tooling

This project uses **mise** for tool version management and **npm** for package management. If you are an AI agent or new contributor, read this first.

### mise (tool version manager)

- **What:** [mise](https://mise.jdx.dev/) manages tool versions (node) and project tasks. Think asdf + direnv + make in one tool.
- **Why:** Reproducible dev environments. `mise.toml` pins exact tool versions so every contributor and CI run uses the same stack.
- **Install:** `curl https://mise.run | sh` then activate: `eval "$(~/.local/bin/mise activate bash)"`
- **Usage:**
  - `mise install` — install all tools from `mise.toml`
  - `mise run <task>` — run a project task (build, test, dev, check, start)
  - `mise use <tool>@<version>` — add/update a tool version

### mcpi (coding agent)

- **What:** [mcpi](https://github.com/SamMorrowDrums/mcpi) is an extensible terminal coding agent (fork of pi). This project builds extensions for it.
- **Extension pattern:** Export a default function receiving `ExtensionAPI`, register tools/commands/hooks.
- **Load extension:** `mcpi --extension ./dist/index.js`

## Dev Loop

```sh
mise install         # one-time: install node
npm install          # install npm dependencies
mise run build       # compile TypeScript
mise run test        # run tests
mise run dev         # watch mode for development
mise run check       # type-check only
mise run lint        # lint TypeScript files
mise run format      # auto-format code with Prettier
mise run format:check # check formatting (CI mode)
```

## Project Structure

```
src/
  index.ts             Extension entry point (lifecycle hooks, wiring)
  mcp/                 MCP client management (connections, discovery) + McpPolicy authorization boundary
  skills/              Skill registry, discovery, gating, tool proxies
  tool-cli/            tool-cli RPC server, client, CLI binary, prompt
  test-servers/        Test MCP servers (weather, echo)
dist/                  Compiled output (gitignored)
scripts/               Integration and smoke test scripts
mise.toml              Tool versions and tasks
package.json           Dependencies and npm scripts
tsconfig.json          TypeScript configuration
```

## Architecture

### The MCP policy boundary

Every path that reaches an MCP server crosses `McpPolicy` (`src/mcp/policy.ts`) exactly once. It is the only place that decides whether a tool call or resource read is allowed, and the only place that prompts the user.

| Path             | Entry point                   | `source` tag       |
| ---------------- | ----------------------------- | ------------------ |
| Proxy tools      | `skills/mcp-tool-proxy.ts`    | `proxy`            |
| Code Mode        | `code-mode/index.ts` dispatch | `code-mode`        |
| tool-cli RPC     | `tool-cli/provider.ts`        | `tool-cli`         |
| Skill discovery  | `skills/discover.ts`          | `skill-discovery`  |
| Skill activation | `skills/load-skill-tool.ts`   | `skill-load`       |
| SEP-2640 skills  | `skills/sep2640/*`            | `skills-extension` |

The ordered pipeline for a tool call: server connected → tool present in the discovered set → not skill-gated → arguments valid against the declared input schema → not cancelled → permission → dispatch. Every denial happens **before** the upstream call, and every outcome (allowed or denied) appends exactly one audit record.

Permission rules:

- **Read-only** (`readOnlyHint === true && destructiveHint !== true`) — no prompt.
- **Code Mode + non-read-only** — refused outright, never prompted. Visibility is not authority.
- **Other sources + non-read-only** — user confirmation, unless an approved skill grant already unlocked the tool (recorded as `reused`, not prompted again).
- **No UI available** — treated as _not approved_, never as approval.

Skill grants from MCP servers require explicit user approval and are bound to server + resource URI + a hash of the sorted tool list, so widening `allowed-tools` or replaying a grant from a different server re-prompts. Resource reads use the same policy: `skill://` URIs are origin-bound to the server that advertised them, and a discovery pass does not authorize a skill-load read.

For SEP-2640 skills the `skills-extension` source narrows this further: reads are authorized by exact membership in _that skill's_ declared `resources` set (keyed `serverName` + `skillUri`), not by the per-server skill index, and the grant key additionally carries a fingerprint of the resource set so rotated content re-prompts. See [docs/skills.md](docs/skills.md) — the extension is **Draft** and gated off by default.

`McpClientManager` is the transport gateway beneath the policy — it owns connections and protocol negotiation, not authorization.

### Tiered MCP Tool Access

The extension provides three tiers for exposing MCP tools to the agent:

| Tier          | Mechanism                                                          | When Used                              |
| ------------- | ------------------------------------------------------------------ | -------------------------------------- |
| 1 — Skills    | `deferred: true` + `tool_call` gate → tools unlocked by load_skill | MCP server ships skills                |
| 2 — tool-cli  | CLI progressive discovery via shell                                | Ad-hoc exploration, no skills          |
| 3 — Code Mode | search+execute, read-only tools only (refused, not prompted)       | Read-only tools with structured output |

Tier 1 has two discovery contracts, never mixed on the same server: legacy `skill://` resource listing, and the digest-verified SEP-2640 extension when the server declares `io.modelcontextprotocol/skills` and the gate is on.

### tool-cli Architecture

tool-cli is a thin CLI binary that communicates with the extension via JSON-RPC 2.0 over HTTP. The agent uses it as a standard shell command, composable with pipes, grep, jq, loops, etc.

```
Agent (mcpi)
  │
  │  shell exec
  ▼
tool-cli <server> <tool> '{"args"}'
  │
  │  HTTP JSON-RPC (authenticated, localhost)
  ▼
ToolCliRpcServer (in extension process)
  │
  │  createPolicyToolProvider
  ▼
McpPolicy  ← shared authorization boundary
  │
  │  MCP protocol (stdio/HTTP)
  ▼
MCP Server(s)
```

**Key design points:**

- **Authenticated, but not trusted** — the RPC server binds a random port and requires a session token, so other local processes cannot call it. Authentication is not authorization: an authenticated caller can still name any string it likes, so every call is re-authorized by `McpPolicy` behind the provider.
- **Authorization happens in `McpPolicy`, not in the RPC server** — `ToolCliServer.callTool` forwards `server`/`tool`/`args` to the provider without checking membership in the discovered set. `createPolicyToolProvider` closes that gap: the provider exposes only the policy-visible tools and routes every call back through the same dispatcher used by the proxy and Code Mode paths, so a hidden or gated tool is refused before the MCP server is contacted.
- **Progressive discovery** — the agent discovers servers → tools → schemas incrementally, paying only the tokens it needs.
- **Shell-native** — plain text output composes with grep, jq, xargs, pipes, loops. The agent can chain tool calls using standard bash idioms.

## Code Quality

- **ESLint** — flat config with `typescript-eslint` (strict + stylistic) and Prettier compat
- **Prettier** — auto-formatting (double quotes, semicolons, trailing commas, 100 char width)
- **CI** — GitHub Actions runs lint → format:check → type-check → build → test on every PR
- **Dependabot** — automated dependency updates (npm + GitHub Actions)

Run `mise run lint` and `mise run format` before committing. CI will reject PRs that fail any check.

**Before pushing**, always run:

```sh
mise run lint        # lint must pass
mise run test        # tests must pass
mise run format:check # formatting must pass
```

## Decision Log

We maintain a [DECISIONS.md](DECISIONS.md) file recording key architectural and design decisions. Keep it up to date when making significant choices — add a new numbered entry with date, context, decision, and rationale.

## Conventions

- ESM (`"type": "module"`)
- Target: ES2022, module: Node16
- Strict TypeScript
- Tests with vitest (co-located `*.test.ts` files)
