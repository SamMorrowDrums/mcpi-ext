# Code mode

Code Mode is always available for pure JavaScript computation, even when no MCP servers are configured. Its discovery catalog and generated type hints include every MCP tool, but host dispatch is allowed only when `annotations.readOnlyHint === true` and `annotations.destructiveHint !== true`.

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
- **No access** to filesystem, network, `process`, or Node.js/browser APIs
- Tool calls dispatch to the host via `Reference` callbacks — MCP execution happens outside the sandbox
- ~15ms overhead, negligible vs network I/O

## Catalog, schemas, and dispatch

Code Mode keeps discovery separate from permission enforcement, and separate from skills:

1. Every MCP tool appears in `codemode.listTools()` and the generated type hints — every discovered tool, whether or not any skill references it. Code Mode never requires `load_skill`.
2. Read-only, non-destructive tools dispatch unattended.
3. Every tool without an `outputSchema` receives an internal permissive JSON Schema survival floor. Its output type is `unknown`, and the source MCP tool remains unchanged. This applies to write tools too: a tool the model can call is a tool it needs a return type for.
4. A write or destructive tool **pauses mid-script for user approval** at `McpPolicy`, the same confirmation any other surface raises, and the script continues with the value it returns. A decline surfaces as a legible error naming the tool.

Point 4 used to read the other way — the sandbox refused writes outright rather than prompting. That was not the conservative choice it looked like: it took a decision away from the person entitled to make it and left scripts able to see work they could never finish. Sandbox restrictions (no fs, no network, no process) are a separate matter and unchanged; they constrain what the _isolate_ can reach, not what the user may authorise.

Schema provenance is client-internal (`declared`, `synthesized`, or `unavailable`) and is never added to MCP traffic. Code Mode diagnostics and the type-hint header report declared and synthesized counts so schema degradation is visible without prompting.

Approval posture is classified separately from the boolean, as `read_only`, `write`, `destructive`, or `contradictory_annotations`, with a normalized reason set. `McpPolicy` remains the sole authority on whether a call prompts; the classification describes that decision for diagnostics and for the catalog's definition fingerprint, so a tool that acquires `destructiveHint` invalidates a cached snapshot rather than inheriting its old classification.

## Tools

| Tool           | Purpose                                                          |
| -------------- | ---------------------------------------------------------------- |
| `code_search`  | Discover available tools across the full discovered catalogue    |
| `code_execute` | Chain tool calls — write JS that calls `codemode.toolName(args)` |

With zero callable MCP tools, `code_search` names `code_execute` and `tool-cli` as alternatives. `code_execute` still handles arithmetic, parsing, and deterministic transforms.

## When to use

Code Mode shines when you need real computation across many calls: pagination loops, aggregation, joining results, math. For example:

- 876 issues across 9 pages, counting labels per issue, building a histogram
- For each open PR, fetch reviews and compute average time-to-first-review
- Paginate all items, filter, group, and summarize

The sandbox is exact but sealed: no filesystem, no network, no process access. Work that has to produce a file, run a program, or touch the machine needs bash, not Code Mode.

Cross-facility choice is not described here or in `CodeModeManager`'s own prompt appendix — that appendix covers Code Mode only. The `<execution_routing>` section is the single place that compares facilities, and it does so by task shape rather than precedence. See [AGENTS.md](../AGENTS.md#execution-routing-srcrouting).

See [DECISIONS.md #011–012, #014, and #017](../DECISIONS.md) for implementation decisions.
