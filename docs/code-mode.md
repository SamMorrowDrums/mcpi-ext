# Tier 3 — Codey C. Maude (Code Mode)

Code Mode targets tools that are **read-only** (`annotations.readOnlyHint === true`) and return **structured output** (`outputSchema` defined). These two properties together make a tool safe for autonomous use — it can't modify anything, and its results are machine-parseable.

## How it works

The model writes JavaScript that chains MCP tool calls. The code runs in a V8 isolate via `isolated-vm`:

```javascript
const issues = await codemode.list_issues({ repo: "owner/repo", state: "open" });
const critical = issues.filter((i) => i.labels.includes("critical"));
const details = await Promise.all(critical.map((i) => codemode.get_issue({ number: i.number })));
return details.map((d) => ({ title: d.title, assignee: d.assignee }));
```

## Sandbox isolation

- **128MB memory limit**, 30-second timeout
- **No access** to filesystem, network, or Node.js APIs
- Tool calls dispatch to the host via `Reference` callbacks — MCP execution happens outside the sandbox
- ~15ms overhead, negligible vs network I/O

## Tools

| Tool           | Purpose                                                                            |
| -------------- | ---------------------------------------------------------------------------------- |
| `code_search`  | Discover available tools — `codemode.listTools()`, `codemode.describeTools(names)` |
| `code_execute` | Chain tool calls — write JS that calls `codemode.toolName(args)`                   |

## When to use

Code Mode shines when you need real computation across many calls: pagination loops, aggregation, joining results, math. For example:

- 876 issues across 9 pages, counting labels per issue, building a histogram
- For each open PR, fetch reviews and compute average time-to-first-review
- Paginate all items, filter, group, and summarize

See [DECISIONS.md #011–012](../DECISIONS.md) for implementation decisions.
