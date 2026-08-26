# mcpi-ext

[![npm](https://img.shields.io/npm/v/@sammorrowdrums/mcpi)](https://www.npmjs.com/package/@sammorrowdrums/mcpi)
[![npm](https://img.shields.io/npm/v/@sammorrowdrums/mcpi-ext)](https://www.npmjs.com/package/@sammorrowdrums/mcpi-ext)
[![npm](https://img.shields.io/npm/v/@sammorrowdrums/tool-cli)](https://www.npmjs.com/package/@sammorrowdrums/tool-cli)

> **Experimental.** This extension implements progressive MCP tool discovery via skills for [mcpi](https://github.com/SamMorrowDrums/mcpi) (an experimental pi fork). See the [skills-as-groups proposal](https://github.com/modelcontextprotocol/experimental-ext-grouping/pull/13) for the proposed MCP spec addition, and the [progressive tool discovery docs](https://github.com/SamMorrowDrums/mcpi/blob/main/docs/progressive-tool-discovery.md) for implementation details.

```sh
npm install -g @sammorrowdrums/mcpi@latest @sammorrowdrums/mcpi-ext@latest @sammorrowdrums/tool-cli@latest
mcpi --extension $(npm root -g)/@sammorrowdrums/mcpi-ext/dist/index.js \
  --mcp-config ~/.config/mcpi-ext/mcp.json
```

See [Quick Start](#quick-start) for MCP server configuration.

---

![Three figures in a dark, Sandman-esque realm — The Skill Dealer, The Nuclear Football, and Codey C. Maude — standing before swirling constellations of MCP tool connections](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/banner.webp)

> _They will tell you that MCP has a context problem. That the protocol gives too many tools, that the model drowns in schemas it doesn't need, that the cost of knowing everything is losing the ability to do anything well._
>
> _They are wrong._
>
> _MCP doesn't have a context problem. It has an imagination problem. The protocol already contains everything you need — `skill://` resources, tool annotations, `outputSchema`, progressive discovery. The pieces are all there, lying in the open like runes on a hillside. You just have to read them._
>
> _What follows is the story of three who did._

---

Building custom [MCP](https://modelcontextprotocol.io/) support as [mcpi](https://github.com/SamMorrowDrums/mcpi) extensions. This project implements **tiered progressive discovery** — three complementary strategies for exposing MCP tools to an AI agent, each paying only the context tokens it needs.

| Tier          | Aspect                   | Mechanism                                           |
| ------------- | ------------------------ | --------------------------------------------------- |
| 1 — Skills    | **The Skill Dealer**     | `skill://` resources gate tools via `allowed-tools` |
| 2 — tool-cli  | **The Nuclear Football** | CLI progressive discovery via shell                 |
| 3 — Code Mode | **Codey C. Maude**       | Always-on sandboxed JS with read-only MCP dispatch  |

---

## I. The Skill Dealer

![A shadowy figure behind a table of glowing cards, each card inscribed with the name of an MCP tool](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/the-skill-dealer.webp)

> _The Skill Dealer does not give you what you ask for. The Skill Dealer gives you what you need — and nothing more._

MCP servers ship `skill://` resources — SKILL.md files declaring which tools a skill gates. The extension discovers skills on connection and registers their tools with `deferred: true`: present in the registry for dispatch but hidden from the model and the prompt. **Cache is preserved** — neither the tools array nor the system prompt ever changes.

When the model calls `load_skill`, the skill's instructions arrive and its tools are unblocked. The model discovers tools from the skill body and can call them immediately. The MCP server itself declares how its tools should be discovered.

Anthropic's [tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) solves a similar problem from the model side -- deferring tool loading to avoid cache invalidation from large tool lists. But where tool search has the model _pull_ tools on demand, skill invocation _pushes_ them: when `load_skill` fires, the harness sends unsolicited tool definitions to the model API alongside the skill instructions. The model doesn't search for tools -- the right tools arrive because the skill declared them.

📖 [**How it works →**](https://github.com/SamMorrowDrums/mcpi-ext/blob/main/docs/skills.md) — deferred gating, `defer_loading` provider support, `tool_call` hook enforcement.

> _"What you do not need to know," said the Skill Dealer, shuffling the deck, "you will not be burdened with knowing."_

![Skills enabling MCP tools — the model loads a skill and gains access to gated tools](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/skills-enabling-mcp-tools.png)

---

## II. The Nuclear Football

![A glowing briefcase marked 'tool-cli' being passed between hands in a dark corridor, trailing sparks of shell commands](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/nuclear-mcp-football.webp)

> _The Football is not a weapon. The Football is the authority to use weapons. Whoever holds it can reach any server, call any tool, chain any result — but they must do so deliberately, one command at a time._

[`tool-cli`](https://github.com/SamMorrowDrums/tool-cli) is a thin CLI binary that speaks authenticated bridge protocol v1 to the extension. The agent uses it like any shell command — composable with pipes, grep, jq, loops. Discovery is progressive: server list → tool list → schema → call. The same policy-backed bridge lists and reads ordinary MCP resources, including binary `--out` files, while keeping `skill://` and SEP-2640-declared skill resources isolated behind `load_skill`.

📖 [**How it works →**](https://github.com/SamMorrowDrums/mcpi-ext/blob/main/docs/tool-cli.md) — architecture, progressive discovery, shell composability.
📦 [**Standalone package →**](https://github.com/SamMorrowDrums/tool-cli) — `ToolProvider` interface, server, and implementor guidance for other languages.

This is the dual-lock design: the agent holds the briefcase -- reach to every server, every tool, every chain of commands. But the harness holds the launch authority. The HTTP layer isn't a separate service with its own auth; it runs inside the extension process. Every call routes back through `McpPolicy`, the shared authorization boundary, giving full observability and a single HITL choke point. Bestow executive control to the agent, but keep the safety in the infrastructure.

> _They pass the Football from hand to hand. It is heavy with potential. Every tool on every server is one command away — but you must type the command yourself. And somewhere behind you, the harness is watching._

![tool-cli in action — progressive discovery piped through grep](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/tool-cli-grep.png)

---

## III. Codey C. Maude

![A luminous figure composed of flowing code, sitting cross-legged in a V8 isolate bubble, reading structured data from floating JSON schemas](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/code-c-maude.webp)

> _Codey does not ask permission. Codey does not need to. Everything Codey touches is explicitly read-only, and the sandbox cannot be escaped. Codey is safe by construction._

Code Mode is always available for arithmetic, parsing, and deterministic transforms. It catalogs every MCP tool, but only dispatches tools that are explicitly **read-only** and non-destructive. Declared output schemas produce precise hints; read-only tools without one get a client-internal permissive survival schema with visible provenance. The model's JavaScript runs inside a memory- and time-limited V8 isolate with no filesystem, network, or process access.

📖 [**How it works →**](https://github.com/SamMorrowDrums/mcpi-ext/blob/main/docs/code-mode.md) — sandbox isolation, catalog provenance, tool dispatch.

> _"I can see everything," Codey said, eyes reflecting infinite JSON. "I just can't touch it. That's the point. That's why they trust me."_

![Code Mode in action — chaining MCP tools in a V8 sandbox to build a histogram](https://raw.githubusercontent.com/SamMorrowDrums/mcpi-ext/main/images/code-mode-histogram.png)

---

## Choosing an Execution Facility

Whenever the extension loads it emits a single `<execution_routing>` prompt section describing the
facilities available to the agent — **including when zero MCP servers are connected**. The section
sorts facilities by task shape, not by rank: none is a default, none outranks another, and there is
no sequence to try them in. Every facility states its own availability, so an unavailable one is
listed with the reason rather than silently omitted.

Three of the four facilities come from this extension; the fourth is the host's own shell, described
alongside them because most real tasks need it.

| Facility                             | Suits work that is…                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| [Skills](#i-the-skill-dealer)        | a documented domain workflow — sequencing, conventions, and a curated tool set              |
| [Code mode](#iii-codey-c-maude)      | exact computation or control flow, sandboxed with no filesystem, network, or process access |
| [tool-cli](#ii-the-nuclear-football) | reaching a specific MCP tool, or discovering what exists — run through the host bash tool   |
| bash + external programs             | touching the real machine: files, git, build tools, data pipelines, artifacts that persist  |

**Skills** — when a curated workflow exists for the domain task. "Triage these 20 issues" means
loading the triage skill, which supplies the right tools _plus_ the workflow instructions (dedup
checks, labeling conventions, close criteria). Re-deriving that from raw tool calls is wasteful and
error-prone. A skill enables the tools it declares only after the grant is approved.

**Code mode** — when you need real computation across many calls: pagination loops, aggregation,
joining results, math. 876 issues across 9 pages, counting labels per issue, summing into a
histogram — that's a loop with state, and one sandbox execution does it. Available even with zero
MCP servers connected, because pure computation needs no server.

**tool-cli** — one-shot or exploratory MCP calls, especially when piping through Unix tools.
`tool-cli github search_code '{"query":"auth"}' | jq '.items[].path'` — one call, pipe to jq, done.
Also the way to discover what's on a server you haven't used before. It is a program, not a tool:
the agent invokes the bash tool with a `tool-cli ...` command. It is advertised as available only
after bash is active and the local server completes an authenticated compatible v1 handshake;
inherited credentials are masked and usage docs remain withheld on startup, timeout, auth, or
major-version failure.

**bash + external programs** — the substrate the other three lack. It is the only facility that can
create, modify, or inspect files and artifacts, and the only one that runs the host's real programs.

### Facilities compose

tool-cli and bash compose especially closely: because tool-cli _is_ a program run with the bash
tool, fetching MCP data and then filtering, joining, or writing it to disk with ordinary programs is
a single bash command rather than two rival approaches.

> _"Triage the backlog of github/github-mcp-server: find stale bugs older than 90 days with no recent activity, summarize patterns, and close obvious duplicates."_

1. **Code mode** paginated all open bug issues, filtered by `updated < 90d ago`, grouped by label
   and keyword to find clusters. Computation across many pages — this is what sandboxes are for.

2. **tool-cli** spot-checked suspect issues. `tool-cli github get_issue '{"number":42}'` piped
   through `jq` to eyeball specific fields. Quick, ad-hoc, composable.

3. **A skill** (`triage-issues`) drove the actual closures — following the project's triage
   workflow with correct labels, comment templates, and close reasons.

4. **bash** wrote the resulting summary to a file in the repo, because none of the other three can
   touch the filesystem.

---

## The Architecture

```mermaid
flowchart TD
    subgraph mcpi["mcpi (agent)"]
        T1["load_skill\n(Tier 1 — Skills)"]
        T2["tool-cli\n(Tier 2 — Football)"]
        T3["code_search / code_execute\n(Tier 3 — Code Mode)"]
        MCM["McpClientManager\n(split MCP v2 client — stdio & Streamable HTTP)"]
        T1 --> MCM
        T2 --> MCM
        T3 --> MCM
    end
    MCM --> S1["MCP Server"]
    MCM --> S2["MCP Server"]
    MCM --> S3["MCP Server"]
```

The harness controls what the model sees. MCP servers just expose their tools and skills. The extension decides _when_ and _how_ to reveal them.

### Every call flows through the harness

All three tiers route MCP tool calls back through the extension process, and every one of them crosses the same authorization boundary: `McpPolicy`. Even when the model writes sandboxed JavaScript (Code Mode) or shells out to `tool-cli`, the actual MCP call is authorized and dispatched by that one object. This means:

- **Every tool invocation appears in the agent log** — skills, tool-cli one-shots, and Code Mode sandbox calls alike. Full observability without instrumentation.
- **Human-in-the-loop happens at one point** — `McpPolicy` checks tool annotations (`readOnlyHint`, `destructiveHint`) and gates non-read-only calls through user confirmation, regardless of which tier initiated them. A tool unlocked by an approved skill grant is not re-prompted.
- **Undiscovered and gated tools never reach upstream** — the policy verifies the tool exists in the discovered set and is not skill-gated before contacting the server, so naming a hidden tool over the authenticated RPC socket fails at the boundary.
- **Resource operations use the same policy** — tool-cli can list templates and read ordinary text/binary resources, while every `skill://` URI and SEP-2640-declared resource remains isolated; skill reads are origin-bound, and a discovery pass cannot authorize a skill-load read.
- **Every decision is audited** — allowed and denied operations alike are recorded with their source (`proxy`, `code-mode`, `tool-cli`, `skill-discovery`, `skill-load`).

> _MCP doesn't have a context problem. It never did. It was just waiting for someone to imagine the right way to read the runes._

---

## Quick Start

### 1. Install

```sh
npm install -g @sammorrowdrums/mcpi@latest @sammorrowdrums/mcpi-ext@latest @sammorrowdrums/tool-cli@latest
```

### 2. Configure MCP servers

Create `~/.config/mcpi-ext/mcp.json`:

```json
{
  "mcpServers": {
    "github": {
      "type": "stdio",
      "command": "docker",
      "args": [
        "run",
        "--rm",
        "-i",
        "-e",
        "GITHUB_PERSONAL_ACCESS_TOKEN",
        "ghcr.io/github/github-mcp-server:skill-discovery",
        "stdio"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "xxx"
      }
    }
  }
}
```

Replace `xxx` with your [GitHub personal access token](https://github.com/settings/tokens). See [github/github-mcp-server](https://github.com/github/github-mcp-server) for the standard server.

> **Note:** The `skill-discovery` tag includes experimental `skill://` resources that enable Tier 1 progressive discovery. The standard `ghcr.io/github/github-mcp-server` image works too — tool-cli (Tier 2) and Code Mode (Tier 3) function with any MCP server, but skill-gated tool activation requires `skill://` resources.

You can add more servers — both `stdio` (spawns a process) and `remote` (Streamable HTTP) are supported:

```json
{
  "mcpServers": {
    "github": { "...": "..." },
    "my-remote-server": {
      "type": "remote",
      "url": "https://my-mcp-server.example.com/mcp",
      "headers": {
        "Authorization": "Bearer xxx"
      }
    }
  }
}
```

### Protocol compatibility and defaults

mcpi-ext uses `@modelcontextprotocol/client@2.0.0` in automatic version-negotiation
mode. It first probes the released `2026-07-28` protocol with `server/discover`, then
falls back to the legacy `initialize` handshake when a server does not support the
modern era. The connection log reports the negotiated era.

- Tool and skill-resource lists follow cursors automatically, with a 64-page safety
  limit.
- Results without a server-provided `ttlMs` are immediately stale
  (`defaultCacheTtlMs: 0`). Explicit server cache hints are still honored in the
  SDK's in-memory cache; mcpi-ext does not configure a persistent or shared cache.
- Tool-list change handling is enabled. On modern servers the SDK may open a
  `subscriptions/listen` stream when the capability is advertised; legacy servers
  continue to use list-changed notifications. General subscription management,
  durable subscription resume, and live skill-resource refresh are not exposed.
- Modern `input_required` flows support explicit form input, decline, and cancel in
  interactive mcpi sessions. Headless and URL elicitation fail with an actionable
  error rather than approving automatically.

### 3. Run

```sh
mcpi --extension $(npm root -g)/@sammorrowdrums/mcpi-ext/dist/index.js \
  --mcp-config ~/.config/mcpi-ext/mcp.json
```

### Local development

```sh
git clone https://github.com/SamMorrowDrums/mcpi-ext.git
cd mcpi-ext
npm install
npm run build
npm test
```

Then run with your local build:

```sh
mcpi --extension ./dist/index.js --mcp-config ~/.config/mcpi-ext/mcp.json
```

See [AGENTS.md](https://github.com/SamMorrowDrums/mcpi-ext/blob/main/AGENTS.md) for full tooling docs, dev loop, and architecture details.

## Project Structure

```
src/
  index.ts             Extension entry point (lifecycle hooks, wiring)
  mcp/                 MCP client management (connections, discovery) + McpPolicy
  routing/             Execution-facility descriptors, prompt section, host seam
  skills/              Skill registry, discovery, gating, tool proxies
  tool-cli/            tool-cli RPC server, provider, bridge handshake, prompt
  code-mode/           V8 sandbox executor, lazy isolated-vm adapter, type hints
  test-servers/        Test MCP servers (weather, echo, skills fixtures)
docs/                  Detailed mechanism documentation
images/                Banner, character art, and screenshots
scripts/               Integration, smoke, and release-check scripts
tsconfig.json          Development build (compiles tests and fixture servers)
tsconfig.build.json    Published build (no tests, fixtures, or source maps)
```

## Requirements

Node.js `>=22.13.0`. Node 22 and 24 are both covered by CI.

Code Mode needs the optional [`isolated-vm`](https://github.com/laverdet/isolated-vm)
native addon. It ships prebuilt binaries for Linux (x64, arm64), macOS
(Apple Silicon), and Windows (x64), so the usual install is a download rather than a
compile. Where no prebuild matches — Intel macOS, for instance — npm compiles it from
source and needs a C++ toolchain.

If the addon is unavailable for any reason, installation still succeeds and the
extension still loads. Code Mode reports itself unavailable with the specific cause,
and skills, tool-cli, and execution routing continue to work. Code Mode never falls
back to `node:vm`: that would silently downgrade an isolate boundary to same-process
execution and hand sandboxed code the host realm.

To skip the addon deliberately, install with `npm install --omit=optional`.

## License

[MIT](LICENSE)
