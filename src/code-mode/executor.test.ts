import { describe, expect, it } from "vitest";
import { executeInSandbox, normalizeCode } from "./executor.js";

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

describe("executeInSandbox", () => {
  it("executes simple code and returns result", async () => {
    const result = await executeInSandbox("return 2 + 2;", [], async () => ({}), {
      timeoutMs: 5000,
    });

    expect(result.result).toBe(4);
    expect(result.error).toBeUndefined();
  });

  it("captures console.log output", async () => {
    const result = await executeInSandbox(
      'console.log("hello", "world"); return 1;',
      [],
      async () => ({}),
      { timeoutMs: 5000 },
    );

    expect(result.result).toBe(1);
    expect(result.logs).toContain("hello world");
  });

  it("dispatches tool calls through the callback", async () => {
    const dispatched: { name: string; args: Record<string, unknown> }[] = [];

    const dispatch = async (name: string, args: Record<string, unknown>) => {
      dispatched.push({ name, args });
      return { results: ["doc1", "doc2"] };
    };

    const code = `
      const result = await codemode.search_docs({ query: "test" });
      return result;
    `;

    const result = await executeInSandbox(code, ["search_docs"], dispatch, { timeoutMs: 5000 });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ results: ["doc1", "doc2"] });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].name).toBe("search_docs");
    expect(dispatched[0].args).toEqual({ query: "test" });
  });

  it("handles tools with special characters in names", async () => {
    const dispatched: string[] = [];

    const dispatch = async (name: string) => {
      dispatched.push(name);
      return { ok: true };
    };

    const code = `
      const result = await codemode.github_list_repos({});
      return result;
    `;

    const result = await executeInSandbox(code, ["github.list-repos"], dispatch, {
      timeoutMs: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(dispatched).toContain("github.list-repos");
  });

  it("returns error for invalid code", async () => {
    const result = await executeInSandbox("throw new Error('boom');", [], async () => ({}), {
      timeoutMs: 5000,
    });

    expect(result.error).toContain("boom");
    expect(result.result).toBeUndefined();
  });

  it("enforces timeout", async () => {
    const result = await executeInSandbox("while(true) {}", [], async () => ({}), {
      timeoutMs: 100,
    });

    expect(result.error).toBeDefined();
    expect(result.result).toBeUndefined();
  });

  it("chains multiple tool calls", async () => {
    const calls: string[] = [];

    const dispatch = async (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      if (name === "list_items") return { items: ["a", "b", "c"] };
      if (name === "get_details") return { detail: `info for ${args.id}` };
      return {};
    };

    const code = `
      const { items } = await codemode.list_items({});
      const details = [];
      for (const id of items) {
        const d = await codemode.get_details({ id });
        details.push(d.detail);
      }
      return details;
    `;

    const result = await executeInSandbox(code, ["list_items", "get_details"], dispatch, {
      timeoutMs: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(["info for a", "info for b", "info for c"]);
    expect(calls).toEqual(["list_items", "get_details", "get_details", "get_details"]);
  });

  it("prevents imports", async () => {
    const code = 'import("fs")';
    const result = await executeInSandbox(code, [], async () => ({}), { timeoutMs: 5000 });

    expect(result.error).toBeDefined();
  });

  it("listTools returns available tools", async () => {
    const code = `
      const tools = await codemode.listTools();
      return tools;
    `;

    const result = await executeInSandbox(code, ["search", "execute"], async () => ({}), {
      timeoutMs: 5000,
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual(["search", "execute"]);
  });
});
