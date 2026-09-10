# MCP Server Developer Guide

How to make your MCP server work with mcpi-ext's progressive discovery system. This guide covers skill resources, tool annotations, and output schemas -- the three things that determine how your tools surface to the agent.

> **Context:** Skills reach a host by one of two contracts. The authoritative one is
> [SEP-2640 "Skills Extension"](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640),
> a **live Draft** on the MCP Extensions Track — open, unratified, and still changing. mcpi-ext pins
> revision `753b9f2be43e07fdd070e535d75f190cff14beea` and keeps it **off by default** behind
> `--mcp-skills-extension`. Legacy `skill://` resources remain supported as the compatibility
> fallback for servers that declare no extension. See [skills.md](skills.md).

## Overview

mcpi-ext discovers your server's capabilities automatically on connection. What it finds determines which mechanisms your tools surface through:

| What you provide                          | Mechanism     | What happens                                                        |
| ----------------------------------------- | ------------- | ------------------------------------------------------------------- |
| Skills (SEP-2640 or `skill://` resources) | **Skills**    | Tools deferred until the model loads the skill                      |
| Nothing special                           | **tool-cli**  | Tools discoverable via CLI progressive exploration                  |
| Any MCP tool                              | **Code mode** | Tool callable from sandboxed JS; non-read-only calls pause for HITL |

These mechanisms are complementary, and the table is not a ranking — nothing tries one before another. Every MCP tool appears in Code Mode discovery. Read-only, non-destructive tools run unattended; other tools pause for user approval at execution. Exact compact signatures are returned only by `code_search`/`codemode.describe`, not injected eagerly into the system prompt.

---

## Skill Resources

Skills are the primary way to give the agent curated, workflow-aware access to your tools. When a skill is loaded, the model receives both the instructions for _how_ to use the tools and the tools themselves, in one atomic operation.

### How it works

1. On connection, the harness calls `resources/list` on your server
2. It filters for resources with URIs matching `skill://<name>/SKILL.md`
3. It reads each skill resource and parses the YAML frontmatter
4. Tools declared in the frontmatter are registered as deferred -- present for dispatch but hidden from the model
5. When the model calls `load_skill("your-skill")`, the tools are unblocked and the SKILL.md body is returned as instructions

### SKILL.md format

A skill resource is a markdown file with YAML frontmatter. The URI must follow the pattern `skill://<skill-name>/SKILL.md`.

> **Frontmatter differs by contract.** [SEP-2640](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) defines a frontmatter schema using `metadata.io.modelcontextprotocol/tools` (space-separated tool names) that also supports prompts and resources. The legacy `skill://` path uses the `allowed-tools` YAML array shown below. Both are supported: pick the one matching the contract your server declares, and never mix them on one server.

**Legacy `skill://` format** (used when your server declares no extension):

```markdown
---
name: weather
description: Check current weather and weekly forecasts for any city
allowed-tools:
  - check_weather_for_city
  - check_weekly_forecast_for_city
---

# Weather Forecasting Skill

Use the weather tools to look up conditions for any city.

- **check_weather_for_city** -- returns current temperature, conditions, and humidity
- **check_weekly_forecast_for_city** -- returns a 7-day forecast summary

Always confirm the city name with the user before calling.
```

**SEP-2640 format** ([Draft](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640)):

```markdown
---
name: weather
description: Check current weather and weekly forecasts for any city
metadata:
  io.modelcontextprotocol/tools: "check_weather_for_city check_weekly_forecast_for_city"
---

# Weather Forecasting Skill

Use the weather tools to look up conditions for any city.
...
```

The proposed format is richer -- it can also declare prompts and resources as dependencies:

```yaml
metadata:
  io.modelcontextprotocol/tools: "get_pr list_comments post_comment approve_pr"
  io.modelcontextprotocol/prompts: "pr-review-template"
  io.modelcontextprotocol/resources: "github://pr/{number} github://pr/{number}/diff"
```

### Frontmatter fields

**Current (`allowed-tools`) format:**

| Field           | Required | Description                                                                                     |
| --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `name`          | Yes      | Skill identifier. The model uses this with `load_skill("name")`. Keep it short and descriptive. |
| `description`   | Yes      | One-line summary shown in the skill catalog. Helps the model decide which skill to load.        |
| `allowed-tools` | Yes      | Array of tool names this skill gates. These tools are deferred until the skill is loaded.       |

**Proposed (`metadata`) format:**

| Field                                        | Required | Description                                     |
| -------------------------------------------- | -------- | ----------------------------------------------- |
| `name`                                       | Yes      | Skill identifier.                               |
| `description`                                | Yes      | One-line summary shown in the skill catalog.    |
| `metadata.io.modelcontextprotocol/tools`     | Yes      | Space-separated tool names this skill gates.    |
| `metadata.io.modelcontextprotocol/prompts`   | No       | Space-separated prompt names.                   |
| `metadata.io.modelcontextprotocol/resources` | No       | Space-separated resource URIs or URI templates. |

### Body

The markdown body below the frontmatter is returned verbatim to the model when the skill is loaded. This is your chance to provide:

- **Tool descriptions** -- what each tool does and when to use it
- **Workflow instructions** -- preferred ordering, common patterns, best practices
- **Guardrails** -- things to confirm with the user, edge cases, error handling advice

Write the body as if you're briefing a capable engineer who has never used your API. Be specific about tool behavior, not generic about the domain.

### Registering a skill resource

Using the released split MCP server package:

```typescript
import { McpServer } from "@modelcontextprotocol/server";

const server = new McpServer(
  { name: "my-server", version: "1.0.0" },
  { capabilities: { resources: {} } }, // enable resources capability
);

const SKILL_CONTENT = `---
name: my-skill
description: Short description of what this skill enables
allowed-tools:
  - tool_one
  - tool_two
---

# My Skill

Instructions for the model...
`;

server.registerResource(
  "my-skill", // resource name (internal)
  "skill://my-skill/SKILL.md", // URI (must match skill://<name>/SKILL.md)
  {
    description: "My skill instructions",
    mimeType: "text/markdown",
  },
  async () => ({
    contents: [
      {
        uri: "skill://my-skill/SKILL.md",
        text: SKILL_CONTENT,
        mimeType: "text/markdown",
      },
    ],
  }),
);
```

**Important:** Your server must declare the `resources` capability for skill discovery to work. Without it, `resources/list` will fail and the harness will skip skill discovery for your server.

---

## Grouping Tools Into Skills

### When to create a skill

Create a skill when you have a **coherent workflow** -- a set of tools that are used together for a specific task. Good skill boundaries match how a user thinks about a problem, not how your API is organized internally.

**Good skill boundaries:**

- `github-pr` -- create, review, and merge pull requests (`create_pull_request`, `list_files`, `get_diff`, `add_review_comment`, `merge_pull_request`)
- `github-issues` -- triage and manage issues (`list_issues`, `create_issue`, `update_issue`, `add_label`)
- `database-query` -- read and explore database contents (`list_tables`, `describe_table`, `run_query`)

**Bad skill boundaries:**

- `all-tools` -- one skill gating everything defeats the purpose of progressive discovery
- `get-stuff` / `set-stuff` -- splitting by HTTP verb rather than user intent
- One tool per skill -- too granular; the overhead of loading a skill isn't worth it for a single tool

### When to leave tools ungated

Not every tool needs a skill. Leave tools ungated when:

- They're simple utilities (echo, health check, version info)
- They're useful across many workflows and don't need specialized instructions
- There's only one tool and no workflow context to provide

Ungated tools are always visible via tool-cli and, if eligible, code mode.

### Multiple skills per server

A single MCP server can expose multiple skills. Each skill gates its own subset of tools:

```
Server: github-mcp-server
  skill://github-pr/SKILL.md       gates: [create_pull_request, get_diff, ...]
  skill://github-issues/SKILL.md   gates: [list_issues, create_issue, ...]
  skill://github-search/SKILL.md   gates: [search_code, search_repos, ...]
  echo (ungated)                    always available via tool-cli
```

A tool can appear in multiple skills' `allowed-tools` lists -- it will be revealed when _any_ of those skills is loaded.

---

## Tool Annotations and Schemas for Code Mode

Code mode lets the agent write JavaScript that chains tool calls in a V8 sandbox. Every MCP tool is discoverable **and callable**. What your annotations control is not whether a call is permitted but whether it interrupts the script to ask:

1. **`readOnlyHint: true`** and **`destructiveHint` not `true`** -- dispatches unattended.
2. **Anything else** -- pauses mid-script for the user's confirmation, then continues with the value it returns.

Annotating accurately is therefore a courtesy to the user, not a gate you are passing. Marking a write tool read-only does not unlock anything the user could not have approved; it removes their chance to decide.

```typescript
// Callable from Code Mode with a precise declared output type
server.registerTool(
  "check_weather_for_city",
  {
    description: "Get current weather conditions for a city",
    inputSchema: {
      city: z.string().describe("City name, e.g. 'London'"),
    },
    outputSchema: {
      temperature: z.number().describe("Temperature in Celsius"),
      conditions: z.string().describe("Weather conditions description"),
      humidity: z.number().describe("Humidity percentage"),
      city: z.string().describe("City name"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ city }) => {
    const data = lookupWeather(city);
    return {
      content: [{ type: "text", text: `Weather in ${city}: ${data.conditions}` }],
      structuredContent: {
        temperature: data.temp,
        conditions: data.conditions,
        humidity: data.humidity,
        city,
      },
    };
  },
);
```

### Why annotations and schemas matter

- **`readOnlyHint: true` without `destructiveHint: true`** lets Code Mode run the call unattended
- **Missing/false `readOnlyHint` or true `destructiveHint`** makes the call pause for user approval
- **`outputSchema`** types machine-readable `structuredContent`, but is not a permission signal

For any tool without `outputSchema`, the client creates an internal permissive JSON Schema survival floor. The described envelope uses `structuredContent?: unknown`, provenance is reported as `synthesized`, and the source tool definition is not modified. No provenance marker is sent to the server.

### Returning structured content

When your tool defines an `outputSchema`, return the typed data in `structuredContent` alongside the human-readable `content`:

```typescript
return {
  content: [{ type: "text", text: "Human-readable summary" }],
  structuredContent: {
    // Must match your outputSchema
    temperature: 14,
    conditions: "Cloudy",
    humidity: 78,
    city: "London",
  },
};
```

The harness preserves the complete terminal MCP result. Code Mode code reads the declared data from `result.structuredContent`, including falsey scalar values such as `false`, `0`, `""`, and `null`. It also retains `content`, `_meta`, `isError`, resources, mixed content, text-only results, and extension fields.

The MCP v2 client requires and validates structured content for successful non-error results when an output schema is declared. Tool-level error envelopes can still omit it, so callers must guard `result.isError || result.structuredContent === undefined`.

### How result signatures are generated

The harness reads your `inputSchema` and `outputSchema` and returns an on-demand compact signature from `describe`:

```text
weather/check_weather_for_city [read]
  input:
    city: string
  returns: Promise<{ content: Array<{ type: string } & Record<string, unknown>>;
    structuredContent?: { temperature: number; conditions: string; humidity: number; city: string; };
    isError?: boolean; _meta?: Record<string, unknown>; [field: string]: unknown }>
```

The output schema appears under `structuredContent`, never as the top-level return value. The namespace-only system prompt stays fixed; per-tool signatures enter the transcript only when requested. Write good `description` fields on input properties because `describe` includes them beside the parameters.

### Schema best practices

- **Describe every property.** The `.describe()` text becomes documentation the model reads.
- **Use specific types.** `z.number().int()` is better than `z.any()`. `z.enum(["asc", "desc"])` is better than `z.string()`.
- **Keep output shapes flat when possible.** Deeply nested schemas generate complex signatures that cost tokens.
- **Include pagination fields** if your tool returns paginated results. The model can write loops.
- **Still ship `outputSchema`.** The synthesized schema is a survival floor, not a substitute for an accurate contract.

---

## Combining Skills and Code Mode

A tool can be gated behind a skill _and_ callable from Code Mode. These are independent mechanisms:

- The skill controls **when** the tool appears in the model's tool list
- Code mode annotations control **whether** the tool is callable from sandboxed JavaScript

Code Mode tools are always available -- they don't require `load_skill`. If you gate a Code Mode-eligible tool behind a skill, it will be available via Code Mode immediately, but won't appear as a standalone tool until the skill is loaded.

---

## Complete Example

Here's a full MCP server with a skill, gated tools, Code Mode-eligible tools, and an ungated utility:

```typescript
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const server = new McpServer(
  { name: "inventory-server", version: "1.0.0" },
  { capabilities: { resources: {} } },
);

// Skill resource
server.registerResource(
  "inventory-skill",
  "skill://inventory/SKILL.md",
  { description: "Inventory management skill", mimeType: "text/markdown" },
  async () => ({
    contents: [
      {
        uri: "skill://inventory/SKILL.md",
        text: `---
name: inventory
description: Search and manage product inventory
allowed-tools:
  - search_products
  - update_stock
  - get_product_details
---

# Inventory Management

Use these tools to work with the product catalog.

- **search_products** -- find products by name, category, or SKU
- **get_product_details** -- get full details including stock levels
- **update_stock** -- adjust stock quantities (requires confirmation)

Always search before updating to confirm the correct product.
`,
        mimeType: "text/markdown",
      },
    ],
  }),
);

// Read-only + outputSchema = Code Mode callable with precise types + skill gated
server.registerTool(
  "search_products",
  {
    description: "Search products by name, category, or SKU",
    inputSchema: {
      query: z.string().describe("Search query"),
      category: z.string().optional().describe("Filter by category"),
    },
    outputSchema: {
      products: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          category: z.string(),
          price: z.number(),
          stock: z.number(),
        }),
      ),
      total: z.number().describe("Total matching products"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, category }) => {
    const results = await db.searchProducts(query, category);
    return {
      content: [{ type: "text", text: `Found ${results.length} products` }],
      structuredContent: { products: results, total: results.length },
    };
  },
);

// Write tool -- discoverable and callable from Code Mode; pauses for user approval
server.registerTool(
  "update_stock",
  {
    description: "Update stock quantity for a product",
    inputSchema: {
      productId: z.string().describe("Product ID"),
      quantity: z.number().describe("New stock quantity"),
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
    },
  },
  async ({ productId, quantity }) => {
    await db.updateStock(productId, quantity);
    return {
      content: [{ type: "text", text: `Updated stock for ${productId} to ${quantity}` }],
    };
  },
);

// Ungated utility -- always available via tool-cli
server.registerTool(
  "server_status",
  {
    description: "Get server health status",
    inputSchema: {},
    outputSchema: {
      status: z.enum(["healthy", "degraded", "down"]),
      uptime: z.number().describe("Uptime in seconds"),
    },
    annotations: { readOnlyHint: true },
  },
  async () => ({
    content: [{ type: "text", text: "Server is healthy" }],
    structuredContent: { status: "healthy", uptime: 86400 },
  }),
);
```

In this example:

- `search_products` and `get_product_details` are **skill-referenced** (so their schemas are revealed by `load_skill` on the direct surface) and **run unattended** in Code Mode (read-only with output schemas)
- `update_stock` is **skill-referenced** and **callable everywhere, pausing for approval** when it runs (it writes data)
- `server_status` is **referenced by no skill** — which changes only whether `load_skill` reveals its schema, not whether it can be called — and **runs unattended** (read-only with an output schema)

Being referenced by a skill is about _exposure_: it decides which definitions the model is shown directly. It never decides what may run. All three tools are reachable from Code Mode and tool-cli whether or not any skill is loaded.

---

## Supplying credentials to a local server

This section is for **contributors and local testing**, not for end users following the README
Quick Start.

MCP stdio servers do not inherit your shell environment. The MCP SDK spawns each one with a fixed
safe set — `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `USER` on POSIX (`APPDATA`, `PATH`,
`USERPROFILE` and similar on Windows) — plus whatever the server entry declares explicitly. mcpi-ext
additionally strips every `TOOL_CLI_*` variable so a child server can never inherit this session's
bridge credentials. `mcp.json` performs no `${VAR}` expansion; values are used literally.

So an exported `MY_TOKEN` will **not** reach your server, and you should not document `export` as if
it does.

For a containerised server, prefer Docker's `--env-file` with an absolute path to a `chmod 600`
file, as the README does. For a server you run directly during development, a wrapper script keeps
the secret out of `mcp.json`:

```sh
#!/bin/sh
# ~/.local/bin/my-mcp-server-dev — chmod 700
set -eu
. "$HOME/.config/mcpi-ext/my-server.env"   # chmod 600, contains MY_TOKEN=...
export MY_TOKEN
exec /path/to/my-mcp-server "$@"
```

```json
{
  "mcpServers": {
    "my-server": { "type": "stdio", "command": "/home/you/.local/bin/my-mcp-server-dev" }
  }
}
```

The wrapper runs with the restricted environment, reads the secret from a file it owns, and exports
it only into the server process. Never commit either file.

---

## Running a custom server from a local image

This section is for **contributors with a compatible server checkout in hand**, not for end users
following the README Quick Start. Nothing here makes a custom image available to pull.

The eight-skill GitHub reference server used to develop and test this client — 8 skills over a
31-tool schema set — is **local-only**. It is not published to GHCR, the MCP Registry, or any other
registry or public image tag, and there is no branch or SHA to fetch. It can only be produced from
the exact compatible source checkout. If you do not have that checkout, this section will not help
you; use the official server, which provides code mode and tool-cli but no skills.

With the checkout, build and tag it locally:

```sh
cd /path/to/your/github-mcp-server-checkout
docker build -t github-mcp-server-experimental:local .
```

Then reference that exact local tag in `mcp.json`. The skills extension is behind a server-side
feature flag as well as mcpi-ext's own gate, so enable it on both sides. Credentials come from the
same `chmod 600` env file pattern described above — the token is never written into `mcp.json`, and
`args` are not shell-expanded, so the path must be absolute:

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
        "--env-file",
        "/home/you/.config/mcpi-ext/github-mcp.env",
        "-e",
        "GITHUB_FEATURES=skills_extension_draft",
        "github-mcp-server-experimental:local",
        "stdio"
      ]
    }
  }
}
```

Check your checkout's own documentation for the feature-flag name and any other required setup — it
is the server's contract, not this extension's, and it changes with the draft. `GITHUB_FEATURES` is
passed with `-e` rather than placed in the env file because it is configuration, not a secret;
keeping the two separate means the env file holds only the credential.

Then run mcpi with the client-side gate on:

```sh
mcpi --mcp-config ~/.config/mcpi-ext/mcp.json --mcp-skills-extension
```

Both gates are required. With `--mcp-skills-extension` omitted, mcpi-ext never advertises the
extension at `initialize`, so the server cannot negotiate it however it is built.

---

## Checklist

Before shipping your MCP server with progressive discovery support:

- [ ] Server declares `resources` capability if exposing skills
- [ ] Skill URIs follow `skill://<name>/SKILL.md` pattern
- [ ] SKILL.md frontmatter includes `name`, `description`, and tool declarations (`allowed-tools` or `metadata.io.modelcontextprotocol/tools`)
- [ ] SKILL.md body provides actionable workflow instructions, not just tool descriptions
- [ ] Read-only tools set `annotations: { readOnlyHint: true }`
- [ ] Destructive or write tools set `readOnlyHint: false` and optionally `destructiveHint: true`
- [ ] Tools with typed output define `outputSchema` and return `structuredContent`
- [ ] Schema properties have `.describe()` annotations for on-demand signature generation
- [ ] Tools are grouped into skills by user workflow, not API structure
- [ ] Credentials are supplied by file or wrapper, never by assuming shell inheritance

---

## Further Reading

- [SEP-2640 — Skills Extension](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2640) — the authoritative live Draft defining `skills/list`, `skills/get`, and the `metadata.io.modelcontextprotocol/*` frontmatter keys
- [Skills](skills.md) — deferred gating, `defer_loading` provider support, `tool_call` hook enforcement
- [tool-cli](tool-cli.md) — architecture, progressive discovery, shell composability
- [Code mode](code-mode.md) — sandbox isolation, eligibility, tool dispatch
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) — model-side deferred tool loading (pull model vs skill invocation's push model)
