import { describe, expect, it } from "vitest";
import { CodeModeDispatchError, executeInSandbox, normalizeCode } from "./executor.js";
import type { DiscoverFn, ToolDispatchFn, ToolTarget } from "./executor.js";

describe("normalizeCode", () => {
  it("strips markdown code fences", () => {
    expect(normalizeCode("```js\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("strips typescript fences", () => {
    expect(normalizeCode("```typescript\nconst x = 1;\n```")).toBe("const x = 1;");
  });

  it("wraps arrow function in invocation", () => {
    expect(normalizeCode("async () => { return 42; }")).toBe(
      "return (async () => { return 42; })();",
    );
  });

  it("wraps function declaration in invocation", () => {
    const code = "async function main() { return 42; }";
    const result = normalizeCode(code);
    expect(result).toContain("async function main()");
    expect(result).toContain("return main();");
  });

  it("strips export default", () => {
    const result = normalizeCode("export default async () => { return 42; }");
    expect(result).toContain("return (async () => { return 42; })();");
  });

  it("leaves bare code as-is", () => {
    expect(normalizeCode("const x = 1;\nreturn x;")).toBe("const x = 1;\nreturn x;");
  });
});

interface RunOverrides {
  aliases?: Record<string, string>;
  dispatch?: ToolDispatchFn;
  discover?: DiscoverFn;
  signal?: AbortSignal;
  timeoutMs?: number;
}

function run(code: string, overrides: RunOverrides = {}) {
  return executeInSandbox({
    code,
    aliases: overrides.aliases ?? {},
    dispatch: overrides.dispatch ?? (() => Promise.resolve({})),
    discover: overrides.discover ?? (() => Promise.resolve({})),
    timeoutMs: overrides.timeoutMs ?? 5000,
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  });
}

describe("executeInSandbox", () => {
  it("executes simple code and returns result", async () => {
    const result = await run("return 2 + 2;");

    expect(result.result).toBe(4);
    expect(result.error).toBeUndefined();
  });

  it("does not expose filesystem, network, or process entry points", async () => {
    const result = await run(`return {
      process: typeof process,
      require: typeof require,
      fetch: typeof fetch,
      XMLHttpRequest: typeof XMLHttpRequest
    };`);

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({
      process: "undefined",
      require: "undefined",
      fetch: "undefined",
      XMLHttpRequest: "undefined",
    });
  });

  it("calls tools by canonical ref", async () => {
    const dispatched: { target: ToolTarget; args: Record<string, unknown> }[] = [];
    const dispatch: ToolDispatchFn = (target, args) => {
      dispatched.push({ target, args });
      return Promise.resolve({ results: ["doc1", "doc2"] });
    };

    const result = await run(
      `return await codemode.call("docs", "search_docs", { query: "test" });`,
      { dispatch },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ results: ["doc1", "doc2"] });
    // Server and tool stay separate all the way to the host, so no tool name
    // can merge itself into another server's address.
    expect(dispatched).toEqual([
      {
        target: { kind: "identity", serverName: "docs", toolName: "search_docs" },
        args: { query: "test" },
      },
    ]);
  });

  it("exposes unambiguous aliases that dispatch to canonical refs", async () => {
    const dispatched: ToolTarget[] = [];
    const dispatch: ToolDispatchFn = (target) => {
      dispatched.push(target);
      return Promise.resolve({ ok: true });
    };

    const result = await run(`return await codemode.list_repos({});`, {
      aliases: { list_repos: "github/list-repos" },
      dispatch,
    });

    expect(result.error).toBeUndefined();
    expect(dispatched).toEqual([{ kind: "ref", ref: "github/list-repos" }]);
  });

  it("surfaces structured dispatch errors without turning them into success", async () => {
    const dispatch: ToolDispatchFn = () =>
      Promise.reject(
        new CodeModeDispatchError({
          error: "ambiguous_tool",
          message: 'Tool "list_issues" is published by 2 servers.',
          candidates: ["github/list_issues", "gitlab/list_issues"],
        }),
      );

    const result = await run(`return await codemode.callRef("list_issues", {});`, { dispatch });

    expect(result.result).toBeUndefined();
    expect(result.errorDetails?.error).toBe("ambiguous_tool");
    expect(result.errorDetails?.candidates).toEqual(["github/list_issues", "gitlab/list_issues"]);
  });

  it("returns error for invalid code", async () => {
    const result = await run("throw new Error('boom');");

    expect(result.error).toContain("boom");
    expect(result.result).toBeUndefined();
  });

  it("enforces timeout", async () => {
    const result = await run("while(true) {}", { timeoutMs: 100 });

    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
  });

  it("chains multiple tool calls", async () => {
    const calls: string[] = [];
    const dispatch: ToolDispatchFn = (target, args) => {
      const name = target.kind === "identity" ? target.toolName : target.ref;
      calls.push(name);
      if (name === "list_items") return Promise.resolve({ items: ["a", "b", "c"] });
      if (name === "get_details") return Promise.resolve({ detail: `info for ${String(args.id)}` });
      return Promise.resolve({});
    };

    const code = `
      const { items } = await codemode.call("s", "list_items", {});
      const details = [];
      for (const id of items) {
        const d = await codemode.call("s", "get_details", { id });
        details.push(d.detail);
      }
      return details;
    `;

    const result = await run(code, { dispatch });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(["info for a", "info for b", "info for c"]);
    expect(calls).toEqual(["list_items", "get_details", "get_details", "get_details"]);
  });

  it("prevents imports", async () => {
    const result = await run('import("fs")');

    expect(result.error).toBeDefined();
  });

  it("routes discovery through the host without contacting a server", async () => {
    const asked: { op: string; payload: Record<string, unknown> }[] = [];
    const discover: DiscoverFn = (op, payload) => {
      asked.push({ op, payload });
      return Promise.resolve({ op, ok: true });
    };
    const dispatch: ToolDispatchFn = () => Promise.reject(new Error("must not dispatch"));

    const code = `
      const browsed = await codemode.browse();
      const found = await codemode.search("issues", { limit: 3 });
      const described = await codemode.describe("github/list_issues");
      return [browsed.op, found.op, described.op];
    `;

    const result = await run(code, { discover, dispatch });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(["browse", "search", "describe"]);
    expect(asked.map((entry) => entry.op)).toEqual(["browse", "search", "describe"]);
    expect(asked[1].payload).toEqual({ limit: 3, query: "issues" });
    expect(asked[2].payload).toEqual({ refs: ["github/list_issues"] });
  });

  it("inspects real result shapes in-isolate for tools that declare no output schema", async () => {
    const dispatch: ToolDispatchFn = () =>
      Promise.resolve({ items: [{ number: 7, title: "a bug" }], nextPage: null });

    const code = `
      const result = await codemode.call("github", "list_issues", {});
      return codemode.inspect(result);
    `;

    const result = await run(code, { dispatch });

    expect(result.error).toBeUndefined();
    expect(String(result.result)).toContain("items: array(1)");
    expect(String(result.result)).toContain("number: number: 7");
  });

  it("refuses an oversized return value instead of truncating it", async () => {
    const result = await run(`return "x".repeat(60000);`);

    expect(result.result).toBeUndefined();
    expect(result.errorDetails?.error).toBe("budget_exceeded");
  });

  it("reports cancellation when the host aborts", async () => {
    const controller = new AbortController();
    const dispatch: ToolDispatchFn = () => {
      controller.abort();
      return new Promise(() => {
        /* never settles; the isolate is disposed by the abort */
      });
    };

    const result = await run(`return await codemode.call("s", "slow", {});`, {
      dispatch,
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    expect(result.result).toBeUndefined();
    expect(result.errorDetails?.error).toBe("cancelled");
  });
});
