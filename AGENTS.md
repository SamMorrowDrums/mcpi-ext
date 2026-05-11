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
  mcp/                 MCP client management (connections, tool discovery)
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

### Tiered MCP Tool Access

The extension provides three tiers for exposing MCP tools to the agent:

| Tier          | Mechanism                                                          | When Used                                        |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| 1 — Skills    | `deferred: true` + `tool_call` gate → tools unlocked by load_skill | MCP server ships skills                          |
| 2 — tool-cli  | CLI progressive discovery via shell                                | Ad-hoc exploration, no skills                    |
| 3 — Code Mode | search+execute, no HITL                                            | Read-only tools with structured output (planned) |

### tool-cli Architecture

tool-cli is a thin CLI binary that communicates with the extension via JSON-RPC 2.0 over HTTP. The agent uses it as a standard shell command, composable with pipes, grep, jq, loops, etc.

```
Agent (mcpi)
  │
  │  shell exec
  ▼
tool-cli <server> <tool> '{"args"}'
  │
  │  HTTP JSON-RPC (localhost:7179)
  ▼
ToolCliRpcServer (in extension process)
  │
  │  MCP protocol (stdio/HTTP)
  ▼
MCP Server(s)
```

**Key design points:**

- **No auth (temporary)** — the RPC server binds to `127.0.0.1` only, limiting access to the local machine. This is acceptable for development but not a finished security posture — any local process can call the server and execute MCP tools. Future work should add a shared secret or token (e.g. passed via environment variable to the CLI) so only the intended agent process can make calls.
- **Interception point for HITL** — the RPC server's `callTool` method is the single choke point for all tool execution. Future work can check tool annotations (`readOnlyHint`, `destructiveHint`) here and gate non-read-only calls through user confirmation before forwarding to the MCP server.
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
