# Code mode

Code Mode is always available for pure JavaScript computation, even when no MCP servers are configured. Its catalog indexes every MCP tool. What the model may _call_ is decided per call by `McpPolicy`, not by what discovery shows: visibility is not authority, and hiding a tool the policy would have permitted only makes the model guess.

The system prompt carries namespaces, never tools. Schemas are fetched on demand.

## How it works

The model writes JavaScript that chains MCP tool calls. The code runs in a V8 isolate via `isolated-vm`:

```javascript
const issueResult = await codemode.call("github", "list_issues", {
  owner: "owner",
  repo: "repo",
  state: "OPEN",
  fields: ["number", "title", "labels", "assignees"],
  perPage: 100,
});
if (issueResult.isError || issueResult.structuredContent === undefined) {
  return { isError: issueResult.isError, content: issueResult.content };
}
const issues = issueResult.structuredContent.issues ?? [];
const critical = issues.filter((issue) => issue.labels?.some((label) => label.name === "critical"));
return critical.map((issue) => ({
  number: issue.number,
  title: issue.title,
  assignees: issue.assignees,
}));
```

Tools are addressed by canonical `server/tool` reference. A bare name still works when it is unique across every connected server; when it is not, the call is refused and names the candidates, because guessing between two servers is how you comment on the wrong repository.

Every call returns the raw MCP `CallToolResult` envelope:

```typescript
type CodeModeResult<StructuredContent = unknown> = {
  content: Array<{ type: string } & Record<string, unknown>>;
  structuredContent?: StructuredContent;
  isError?: boolean;
  _meta?: Record<string, unknown>;
  [field: string]: unknown;
};
```

The declared `outputSchema`, when present, supplies `StructuredContent`; without one it remains `unknown`. It does not replace the envelope. Text, image, audio, resource-link, embedded-resource, mixed-content, and text-only results remain in `content`, while `_meta`, `isError`, falsey structured values, and extension fields are preserved.

## Sandbox isolation

- **128MB memory limit**, 30-second timeout
- **No access** to filesystem, network, `process`, or Node.js/browser APIs
- Tool calls dispatch to the host via `Reference` callbacks — MCP execution happens outside the sandbox
- ~15ms overhead, negligible vs network I/O

## Progressive discovery

Code Mode keeps discovery separate from permission enforcement, and separate from skills:

1. Every discovered MCP tool is searchable through `code_search`, whether or not any skill references it. Code Mode never requires `load_skill`.
2. Read-only, non-destructive tools dispatch unattended.
3. Every tool without an `outputSchema` receives an internal permissive JSON Schema survival floor. Its output type is `unknown`, and the source MCP tool remains unchanged. This applies to write tools too: a tool the model can call is a tool it needs a return type for.
4. A write or destructive tool **pauses mid-script for user approval** at `McpPolicy`, the same confirmation any other surface raises, and the script continues with the value it returns. A decline surfaces as a legible error naming the tool and the annotations that made it ask.

Point 4 used to read the other way — the sandbox refused writes outright rather than prompting. That was not the conservative choice it looked like: it took a decision away from the person entitled to make it and left scripts able to see work they could never finish. Sandbox restrictions (no fs, no network, no process) are a separate matter and unchanged; they constrain what the _isolate_ can reach, not what the user may authorise.

Discovery itself used to be paid for the same way. Earlier releases injected a TypeScript signature for every discovered tool into the system prompt on every turn. Against the real 85-tool server that is 33,133 tokens of catalog the model had not asked for, paid again each turn, describing tools it would never call. It also defeated the point of a discovery API: nothing was left to discover.

The prompt now carries only namespaces — 529 tokens for the same server — and the model fetches what it needs:

| Operation                         | Answers                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| `codemode.browse()`               | Which namespaces exist, with a one-line summary and effect class for each |
| `codemode.search(query, options)` | Tools ranked against a query; exact and prefix matches first, then BM25   |
| `codemode.list({ namespace })`    | One page of tools within a namespace, server, or effect class             |
| `codemode.describe(refs)`         | Exact parameters and result-envelope type for specific tools              |
| `codemode.inspect(value)`         | The real shape of a value that came back, computed inside the isolate     |

The same four operations are available as the `code_search` tool for use outside a script. Both surfaces answer from one catalog snapshot, so a script and the tool never disagree.

`list` requires a namespace, server, or effect filter. An unfiltered list would be the full catalog arriving through the back door, which is the thing this surface exists to prevent.

### The prompt is pinned

The namespace section is rendered once at session start and is byte-identical for the rest of the session. A server that connects at turn 20 is immediately reachable through `search` and `describe`, but it does not rewrite the prompt: doing so would invalidate the provider's prefix cache for every remaining turn, which costs far more than the announcement is worth.

Namespaces come from declarations, in order: server-declared toolset metadata, then operator-curated `namespaces` in the MCP config, then a stable server-only fallback. Nothing is inferred from tool names. Name-derived grouping was measured against a real catalog and produced a usable head with a long tail of garbage (`branche`, `or`, `me`, `sub`); garbage in a cached prompt prefix is permanent, whereas the same garbage in a search result is cheap.

## Schemas and honesty

Output schemas are reported as they are, not as we wish they were:

- A **declared** `outputSchema` becomes the type of `result.structuredContent` in `describe`. The MCP v2 client validates successful non-error structured output against that schema.
- `structuredContent` remains optional at the JavaScript boundary because a tool-level `isError` envelope may omit it. Check `result.isError || result.structuredContent === undefined` before reading declared fields.
- An **absent** output schema is rendered as `structuredContent?: unknown`, never as a made-up top-level object. Use `codemode.inspect(result)` first, then inspect `result.structuredContent` when present.
- `codemode.inspect(value)` summarizes the actual shape — keys, types, array lengths, sampled elements — entirely inside the isolate, with no host call and no egress.

Schema provenance is client-internal (`declared`, `synthesized`, or `unavailable`) and never added to MCP traffic.

Approval posture is classified separately from the boolean, as `read_only`, `write`, `destructive`, or `contradictory_annotations`, with a normalized reason set. `McpPolicy` remains the sole authority on whether a call prompts; the classification describes that decision for diagnostics and for the catalog's definition fingerprint, so a tool that acquires `destructiveHint` invalidates a cached snapshot rather than inheriting its old classification.

## Tools

| Tool           | Purpose                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------ |
| `code_search`  | Structured catalog query: `op` is `browse`, `search`, `list`, or `describe`. Runs no code. |
| `code_execute` | Chain tool calls — write JS that calls `codemode.call("server/tool", args)`                |

`code_search` takes typed parameters, not JavaScript. It previously accepted code and ran it through the full execution path, which made a dispatch surface wear a discovery label; it now answers from the local snapshot without contacting a server or starting an isolate.

## Identity and snapshot consistency

A tool is addressed by two separate strings, a server name and a tool name, all the way down to the policy call. The `server/tool` ref is display and input syntax only. The distinction is not cosmetic: a server chooses its own tool names, so a tool called `b/echo` on server `a` renders the same ref as tool `echo` on server `a/b`. Refs are built by joining two attacker-influenced strings, so a colliding ref resolves to neither tool — it is refused, naming both — while `codemode.call("a/b", "echo", {})` still works, because a structured identity cannot be forged by a name.

One execution sees one catalog. The snapshot is captured when the run starts, and every `browse`, `search`, `describe`, alias binding, and dispatch inside the run reads that exact snapshot. Refreshing mid-run would let a script describe a tool from one catalog and call into another.

Across turns, every successful `code_search` response prints its full executable `snapshotId`, including `browse`, `search`, `list`, and `describe`. Pass that exact full value as `code_execute.snapshotId`. A tool's separately labelled `schemaHash`, or a truncated ID, is not a snapshot ID and will fail the pin check.

If the catalog has moved since discovery, the run is refused with `stale_snapshot` before the isolate starts and before any MCP dispatch. Rerun the relevant `code_search` operation, re-check the parameters you use, and pass the new full `snapshotId`. Omitting it is allowed only as an intentional unpinned execution against the current catalog; the tradeoff is that you give up protection against a catalog change between discovery and execution.

The snapshot fingerprint covers identity, namespace, schemas and their provenance, effect class, and callability — not schemas alone. A server flipping `readOnlyHint` changes what a call means without changing any schema, so a fingerprint that ignored it would call two different catalogs the same.

## Budgets

An execution is bounded so a runaway script degrades into a refusal rather than a large bill:

- 64 tool calls per execution, 8 concurrent reads per server
- Writes are serialized, so a script that fans out mutations cannot ask for several approvals at once with no order to reason about
- Search returns 5 results by default and at most 20; `describe` accepts at most 20 refs
- Discovery responses are capped at 24 KB and returned values at 48 KB

An oversized return value is refused with an explanation, not silently truncated: half a serialized object is worse than none. Cancellation reaches the policy and the upstream MCP call, and disposes the isolate.

Plan discovery first, then make one `code_execute` call containing the complete calculation. If an undeclared result shape blocks the first attempt, one bounded inspection execution followed by one corrected retry is reasonable. Repeated executions are not extra call-budget allotments; narrow the query or paginate more coarsely instead.

## When to use

Code Mode shines when you need real computation across many calls: pagination loops, aggregation, joining results, math. For example:

- Fetch open and closed issue counts, read each `structuredContent.total_count`, and add them exactly in one execution
- 876 issues across 9 pages, counting labels per issue, building a histogram
- For each open PR, fetch reviews and compute average time-to-first-review
- Paginate all items, filter, group, and summarize

The sandbox is exact but sealed: no filesystem, no network, no process access. Work that has to produce a file, run a program, or touch the machine needs bash, not Code Mode.

Cross-facility choice is not described here or in `CodeModeManager`'s own prompt appendix — that appendix covers Code Mode only. The `<execution_routing>` section is the single place that compares facilities, and it does so by task shape rather than precedence. See [AGENTS.md](../AGENTS.md#execution-routing-srcrouting).

See [DECISIONS.md #011–012, #014, and #017](../DECISIONS.md) for implementation decisions.
