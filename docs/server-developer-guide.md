# MCP Server Developer Guide

How to make your MCP server work with mcpi-ext's progressive discovery system. This guide covers skill resources, tool annotations, and output schemas -- the three things that determine how your tools surface to the agent.

> **Context:** This implementation is part of an active proposal to add skills-as-groups to the MCP spec. See the [skills-as-groups proposal](https://github.com/modelcontextprotocol/experimental-ext-grouping/pull/13) for the proposed spec addition, and the [progressive tool discovery docs](https://github.com/SamMorrowDrums/mcpi/blob/main/docs/progressive-tool-discovery.md) for how mcpi implements deferred tool loading across providers.

## Overview

mcpi-ext discovers your server's capabilities automatically on connection. What it finds determines which of the three tiers your tools land in:

| What you provide                            | Tier                    | What happens                                       |
| ------------------------------------------- | ----------------------- | -------------------------------------------------- |
| `skill://` resources with tool declarations | **Tier 1 -- Skills**    | Tools deferred until the model loads the skill     |
| Nothing special                             | **Tier 2 -- tool-cli**  | Tools discoverable via CLI progressive exploration |
| `readOnlyHint: true` + `outputSchema`       | **Tier 3 -- Code Mode** | Tools callable from sandboxed JavaScript           |

These tiers are complementary. A single tool can participate in multiple tiers -- for example, a read-only tool with an output schema gated behind a skill will be available via Skills _and_ Code Mode.

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

> **Frontmatter is evolving.** The [skills-as-groups proposal](https://github.com/modelcontextprotocol/experimental-ext-grouping/pull/13) defines a new frontmatter schema using `metadata.io.modelcontextprotocol/tools` (space-separated tool names) that also supports prompts and resources. The current mcpi-ext implementation uses the `allowed-tools` YAML array format shown below. Both formats will be supported during the transition -- adopt the proposed format for new servers.

**Current format** (mcpi-ext implementation):

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

**Proposed spec format** ([skills-as-groups](https://github.com/modelcontextprotocol/experimental-ext-grouping/pull/13)):

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

Ungated tools are always visible via tool-cli (Tier 2) and, if eligible, Code Mode (Tier 3).

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

## Tool Annotations for Code Mode

Code Mode (Tier 3) lets the agent write JavaScript that chains tool calls in a V8 sandbox. A tool is eligible for Code Mode when it meets **both** criteria:

1. **`readOnlyHint: true`** -- the tool does not modify its environment
2. **`outputSchema` is defined** -- the tool returns typed, structured data

```typescript
// Eligible for Code Mode
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

### Why both properties matter

- **`readOnlyHint`** makes the tool safe for autonomous use -- Code Mode has no human-in-the-loop, so only tools that can't modify anything are allowed
- **`outputSchema`** makes the tool's results machine-parseable -- the harness generates TypeScript type hints from it, so the model knows the exact shape of what it will get back

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

The harness prefers `structuredContent` when available. If it's missing, it falls back to parsing the text content as JSON.

### How type hints are generated

The harness reads your `inputSchema` and `outputSchema` and generates TypeScript declarations like:

```typescript
declare const codemode: {
  /**
   * Get current weather conditions for a city
   * @param input.city - City name, e.g. 'London'
   */
  check_weather_for_city: (input: { city: string }) => Promise<{
    /** Temperature in Celsius */
    temperature: number;
    /** Weather conditions description */
    conditions: string;
    /** Humidity percentage */
    humidity: number;
    /** City name */
    city: string;
  }>;
};
```

These hints are injected into the model's system prompt. Write good `description` fields on your schema properties -- they become JSDoc comments that help the model write correct code.

### Schema best practices

- **Describe every property.** The `.describe()` text becomes documentation the model reads.
- **Use specific types.** `z.number().int()` is better than `z.any()`. `z.enum(["asc", "desc"])` is better than `z.string()`.
- **Keep output shapes flat when possible.** Deeply nested schemas generate complex type hints that cost tokens.
- **Include pagination fields** if your tool returns paginated results. The model can write loops.

---

## Combining Skills and Code Mode

A tool can be gated behind a skill _and_ eligible for Code Mode. These are independent mechanisms:

- The skill controls **when** the tool appears in the model's tool list (Tier 1)
- Code Mode eligibility controls **whether** the tool is callable from sandboxed JavaScript (Tier 3)

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

// Read-only + outputSchema = Code Mode eligible + skill gated
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

// Write tool -- skill gated, NOT Code Mode eligible
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

- `search_products` and `get_product_details` are **skill-gated + Code Mode eligible** (read-only with output schemas)
- `update_stock` is **skill-gated only** (writes data, so no Code Mode)
- `server_status` is **ungated + Code Mode eligible** (always available, read-only with output schema)

---

## Checklist

Before shipping your MCP server with progressive discovery support:

- [ ] Server declares `resources` capability if exposing skills
- [ ] Skill URIs follow `skill://<name>/SKILL.md` pattern
- [ ] SKILL.md frontmatter includes `name`, `description`, and tool declarations (`allowed-tools` or `metadata.io.modelcontextprotocol/tools`)
- [ ] SKILL.md body provides actionable workflow instructions, not just tool descriptions
- [ ] Read-only tools set `annotations: { readOnlyHint: true }`
- [ ] Tools with typed output define `outputSchema` and return `structuredContent`
- [ ] Schema properties have `.describe()` annotations for type hint generation
- [ ] Write/destructive tools set `readOnlyHint: false` and optionally `destructiveHint: true`
- [ ] Tools are grouped into skills by user workflow, not API structure

---

## Further Reading

- [skills-as-groups MCP spec proposal](https://github.com/modelcontextprotocol/experimental-ext-grouping/pull/13) — the proposed spec addition for skill frontmatter with `metadata.io.modelcontextprotocol/*` keys
- [Progressive tool discovery docs](https://github.com/SamMorrowDrums/mcpi/blob/main/docs/progressive-tool-discovery.md) — how mcpi implements deferred tool loading across Anthropic and OpenAI providers
- [Skills mechanism (Tier 1)](docs/skills.md) — deferred gating, `defer_loading` provider support, `tool_call` hook enforcement
- [tool-cli (Tier 2)](docs/tool-cli.md) — architecture, progressive discovery, shell composability
- [Code Mode (Tier 3)](docs/code-mode.md) — sandbox isolation, eligibility, tool dispatch
- [Anthropic tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool) — model-side deferred tool loading (pull model vs skill invocation's push model)
