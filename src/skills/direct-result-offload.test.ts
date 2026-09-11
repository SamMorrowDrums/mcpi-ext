import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/client";
import type { ExtensionContext } from "@sammorrowdrums/mcpi";
import { afterEach, describe, expect, it } from "vitest";
import {
  adaptTerminalCallToolResult,
  renderTerminalCallToolResult,
} from "../mcp/call-tool-result.js";
import {
  DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES,
  isDirectMcpResultOffloadDetails,
  isDirectMcpResultOffloadFailureDetails,
  renderDirectMcpProxyResult,
} from "./direct-result-offload.js";

const cleanupDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("direct MCP result offloading", () => {
  it("leaves below-threshold direct results byte-for-byte unchanged", async () => {
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "small result" }],
      structuredContent: { ok: true },
      isError: false,
      _meta: { requestId: "small-1" },
    };
    const terminal = adaptTerminalCallToolResult(protocolResult);

    const rendered = await renderDirectMcpProxyResult(terminal, {
      serverName: "fixture",
      toolName: "lookup",
      toolCallId: "call-small",
      context: makeContext(makeSessionDirectory()),
      trust: "reviewed",
    });

    expect(rendered).toEqual(renderTerminalCallToolResult(terminal));
    expect(rendered.details).toBe(protocolResult);
  });

  it("keeps a text result exactly at the byte threshold inline", async () => {
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES) }],
    };
    const terminal = adaptTerminalCallToolResult(protocolResult);

    const rendered = await renderDirectMcpProxyResult(terminal, {
      serverName: "fixture",
      toolName: "lookup",
      toolCallId: "call-threshold",
      context: makeContext(makeSessionDirectory()),
    });

    expect(rendered).toEqual(renderTerminalCallToolResult(terminal));
    expect(rendered.details).toBe(protocolResult);
  });

  it("writes exact large text and returns only a bounded pointer and preview", async () => {
    const output = Array.from(
      { length: 120 },
      (_, index) =>
        `2026-09-11T12:00:${String(index % 60).padStart(2, "0")}Z job line ${index} ${"x".repeat(150)}`,
    ).join("\n");
    expect(Buffer.byteLength(output)).toBeGreaterThan(20_000);
    const sessionDirectory = makeSessionDirectory();

    const rendered = await renderLarge(
      { content: [{ type: "text", text: output }] },
      sessionDirectory,
    );
    const details = requireOffloadDetails(rendered.details);
    const pointer = rendered.content[0]?.type === "text" ? rendered.content[0].text : "";

    expect(await readFile(details.output.path, "utf8")).toBe(output);
    expect(details.output.utf8Bytes).toBe(Buffer.byteLength(output));
    expect(details.output.sha256).toBe(createHash("sha256").update(output).digest("hex"));
    expect(details.output.contentType).toBe("text/plain; charset=utf-8");
    expect(details.output.format).toBe("single-text-block");
    expect(details.output.path).toBe(resolve(details.output.path));
    expect((await stat(details.output.path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(details.output.path))).mode & 0o777).toBe(0o700);
    expect(pointer).toContain("Full direct MCP output was offloaded");
    expect(pointer).toContain(details.output.path);
    expect(pointer).toContain(`${Buffer.byteLength(output)} UTF-8 bytes`);
    expect(pointer).toContain("Use the normal read tool with line/range selection");
    expect(Buffer.byteLength(pointer)).toBeLessThan(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES);
    expect(pointer).not.toContain(output);
    expect(JSON.stringify(rendered.details)).not.toContain(output);
  });

  it("keeps multibyte UTF-8 previews valid", async () => {
    const output = `BEGIN-${"🥁漢字é".repeat(700)}-END`;
    const rendered = await renderLarge(
      { content: [{ type: "text", text: output }] },
      makeSessionDirectory(),
    );
    const details = requireOffloadDetails(rendered.details);
    const pointer = rendered.content[0]?.type === "text" ? rendered.content[0].text : "";

    expect(await readFile(details.output.path, "utf8")).toBe(output);
    expect(pointer).toContain("BEGIN-");
    expect(pointer).toContain("-END");
    expect(pointer).not.toContain("\uFFFD");
  });

  it("stores multiple text blocks with deterministic separators", async () => {
    const first = `first-${"a".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES)}`;
    const second = `second-${"b".repeat(200)}`;
    const rendered = await renderLarge(
      {
        content: [
          { type: "text", text: first },
          { type: "text", text: second },
        ],
      },
      makeSessionDirectory(),
    );
    const details = requireOffloadDetails(rendered.details);
    const stored = await readFile(details.output.path, "utf8");

    expect(details.output.format).toBe("multipart-text");
    expect(stored).toBe(
      `===== MCP text block 1 of 2 =====\n${first}\n` +
        `===== MCP text block 2 of 2 =====\n${second}`,
    );
  });

  it("stores structured-only output as valid pretty JSON", async () => {
    const structuredContent = {
      jobs: Array.from({ length: 150 }, (_, index) => ({
        id: index,
        status: "completed",
        detail: "z".repeat(40),
      })),
    };
    const rendered = await renderLarge({ content: [], structuredContent }, makeSessionDirectory());
    const details = requireOffloadDetails(rendered.details);
    const stored = await readFile(details.output.path, "utf8");
    const pointer = rendered.content[0]?.type === "text" ? rendered.content[0].text : "";

    expect(details.output.contentType).toBe("application/json; charset=utf-8");
    expect(details.output.format).toBe("structured-json");
    expect(JSON.parse(stored)).toEqual(structuredContent);
    expect(stored).toBe(JSON.stringify(structuredContent, null, 2));
    expect(pointer).toContain('"rootType": "object"');
    expect(pointer).not.toContain(stored);
    expect(Buffer.byteLength(pointer)).toBeLessThan(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES);
  });

  it("stores mixed text and structured content in a deterministic JSON envelope", async () => {
    const text = `job logs\n${"line\n".repeat(700)}`;
    const structuredContent = { conclusion: "failure", annotations: [1, 2, 3] };
    const rendered = await renderLarge(
      {
        content: [{ type: "text", text, annotations: { audience: ["assistant"] } }],
        structuredContent,
        _meta: { requestId: "mixed-1" },
      },
      makeSessionDirectory(),
    );
    const details = requireOffloadDetails(rendered.details);
    const stored = JSON.parse(await readFile(details.output.path, "utf8")) as {
      content: unknown[];
      structuredContent: unknown;
    };

    expect(details.output.format).toBe("mcp-json-envelope");
    expect(stored).toEqual({
      content: [{ type: "text", text, annotations: { audience: ["assistant"] } }],
      structuredContent,
    });
    expect(JSON.stringify(rendered)).not.toContain(text);
    expect(JSON.parse(await readFile(details.manifestPath, "utf8"))).toMatchObject({
      source: "proxy",
      callToolResult: {
        _meta: { requestId: "mixed-1" },
      },
    });
  });

  it("retains MCP error identity while making the offloaded pointer available", async () => {
    const output = `upstream error\n${"denied\n".repeat(600)}`;
    const rendered = await renderLarge(
      {
        content: [{ type: "text", text: output }],
        isError: true,
      },
      makeSessionDirectory(),
    );
    const details = requireOffloadDetails(rendered.details);
    const pointer = rendered.content[0]?.type === "text" ? rendered.content[0].text : "";

    expect(details.isError).toBe(true);
    expect(pointer).toContain("MCP tool reported an error.");
    expect(await readFile(details.output.path, "utf8")).toBe(output);
  });

  it("sanitizes untrusted names and creates collision-safe files", async () => {
    const sessionDirectory = makeSessionDirectory();
    const protocolResult: CallToolResult = {
      content: [{ type: "text", text: "x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES + 1) }],
    };
    const options = {
      serverName: "../../server\\name",
      toolName: "../get/job/logs",
      toolCallId: "../../same-call",
      context: makeContext(sessionDirectory),
      trust: "untrusted" as const,
    };

    const first = requireOffloadDetails(
      (await renderDirectMcpProxyResult(adaptTerminalCallToolResult(protocolResult), options))
        .details,
    );
    const second = requireOffloadDetails(
      (await renderDirectMcpProxyResult(adaptTerminalCallToolResult(protocolResult), options))
        .details,
    );

    expect(first.output.path).not.toBe(second.output.path);
    expect(dirname(first.output.path)).toBe(
      join(sessionDirectory, "mcpi-ext-results", "session-test"),
    );
    expect(basename(first.output.path)).not.toContain("..");
    expect(basename(first.output.path)).not.toContain(sep);
    expect(await readFile(first.output.path, "utf8")).toBe(
      "x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES + 1),
    );
    expect(await readFile(second.output.path, "utf8")).toBe(
      "x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES + 1),
    );
  });

  it("reports atomic persistence failures explicitly without returning the full payload", async () => {
    const blockedSessionPath = makeSessionDirectory();
    await mkdir(dirname(blockedSessionPath), { recursive: true });
    await writeFile(blockedSessionPath, "not a directory", { mode: 0o600 });
    const output = `failure-${"x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES * 2)}`;

    const rendered = await renderLarge(
      {
        content: [
          { type: "text", text: output },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        ],
      },
      blockedSessionPath,
    );
    const details = requireOffloadFailureDetails(rendered.details);
    const pointer = rendered.content[0]?.type === "text" ? rendered.content[0].text : "";

    expect(details.isError).toBe(false);
    expect(pointer).toContain("DIRECT MCP OUTPUT OFFLOAD FAILED");
    expect(pointer).toContain("complete output is unavailable");
    expect(pointer).not.toContain(output);
    expect(JSON.stringify(rendered.details)).not.toContain(output);
    expect(Buffer.byteLength(pointer)).toBeLessThan(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES);
    expect(rendered.content).toContainEqual({
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
  });

  it("preserves non-text semantics and writes audio/blob payloads separately", async () => {
    const audio = Buffer.from("audio payload");
    const blob = Buffer.from([0, 1, 2, 3, 4]);
    const result: CallToolResult = {
      content: [
        { type: "text", text: "x".repeat(DIRECT_MCP_RESULT_INLINE_LIMIT_BYTES + 1) },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "audio", data: audio.toString("base64"), mimeType: "audio/wav" },
        {
          type: "resource_link",
          uri: "https://example.invalid/result",
          name: "result",
        },
        {
          type: "resource",
          resource: {
            uri: "file:///data.bin",
            blob: blob.toString("base64"),
            mimeType: "application/octet-stream",
          },
        },
      ],
    };

    const rendered = await renderLarge(result, makeSessionDirectory());
    const details = requireOffloadDetails(rendered.details);
    const textContent = rendered.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");

    expect(rendered.content).toContainEqual({
      type: "image",
      data: "aW1hZ2U=",
      mimeType: "image/png",
    });
    expect(textContent).toContain("https://example.invalid/result");
    expect(details.binaryArtifacts).toHaveLength(2);
    expect(await readFile(details.binaryArtifacts[0]?.path ?? "")).toEqual(audio);
    expect(await readFile(details.binaryArtifacts[1]?.path ?? "")).toEqual(blob);
    expect(JSON.stringify(rendered.details)).not.toContain(audio.toString("base64"));
    expect(JSON.stringify(rendered.details)).not.toContain(blob.toString("base64"));
  });
});

async function renderLarge(result: CallToolResult, sessionDirectory: string) {
  return renderDirectMcpProxyResult(adaptTerminalCallToolResult(result), {
    serverName: "fixture",
    toolName: "get_job_logs",
    toolCallId: "call-large",
    context: makeContext(sessionDirectory),
    trust: "untrusted",
  });
}

function makeSessionDirectory(): string {
  const directory = resolve(".mcpi-test-artifacts", "direct-result-offload", randomUUID());
  cleanupDirectories.push(directory);
  return directory;
}

function makeContext(sessionDirectory: string): ExtensionContext {
  return {
    sessionManager: {
      getSessionDir: () => sessionDirectory,
      getSessionId: () => "session-test",
    },
  } as unknown as ExtensionContext;
}

function requireOffloadDetails(details: unknown) {
  expect(isDirectMcpResultOffloadDetails(details)).toBe(true);
  if (!isDirectMcpResultOffloadDetails(details)) {
    throw new Error("Expected direct MCP offload details");
  }
  return details;
}

function requireOffloadFailureDetails(details: unknown) {
  expect(isDirectMcpResultOffloadFailureDetails(details)).toBe(true);
  if (!isDirectMcpResultOffloadFailureDetails(details)) {
    throw new Error("Expected direct MCP offload failure details");
  }
  return details;
}
