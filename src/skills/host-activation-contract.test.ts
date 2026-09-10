import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpClientManager } from "../mcp/client-manager.js";
import { McpPolicy } from "../mcp/policy.js";
import { createWeatherServer } from "../test-servers/weather-server.js";
import { SkillRegistry } from "./skill-registry.js";
import { discoverSkillsFromServer } from "./discover.js";
import { createLoadSkillTool } from "./load-skill-tool.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Cross-package contract: `load_skill` activation against the *installed*
 * mcpi host, not a local re-implementation of it.
 *
 * Activation is the seam where this extension is most exposed to silent
 * breakage. `load_skill` can return a perfectly well-formed result, the tests
 * in this repository can all pass, and the model can still never see the
 * definitions the skill was supposed to reveal — because the host reads one
 * exact field and we wrote a different one. That is not hypothetical: it is
 * the defect this file exists to catch, where the extension emitted
 * `details.activatedTools` and the host consumed `addedToolNames`.
 *
 * So these tests deliberately reach into `node_modules` and drive the real
 * published provider. A local fake would agree with whatever we wrote and
 * prove nothing. Resolution goes through mcpi's own `require` so we get the
 * exact `mcpi-ai` build that mcpi itself loads — mcpi ships a shrinkwrap, so
 * its dependencies install nested rather than hoisted, and the copy at the
 * top level of `node_modules` may not be the one that runs.
 */

interface HostTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface HostContext {
  systemPrompt: string;
  tools: HostTool[];
  messages: unknown[];
}

type SplitDeferredTools = (
  context: HostContext,
  enabled: boolean,
) => { immediate: HostTool[]; deferred: Map<string, HostTool> };

type StreamFn = (
  model: Record<string, unknown>,
  context: HostContext,
  options: Record<string, unknown>,
) => AsyncIterable<unknown>;

let splitDeferredTools: SplitDeferredTools;
let stream: StreamFn;
let typesDeclaration: string;
let hostVersion: string;

beforeAll(async () => {
  // Neither package exports `./package.json`, and mcpi publishes only an
  // `import` condition, so `require.resolve` cannot see it. Resolve the ESM
  // entry point and walk up to the manifest that names the package.
  const packageRootOf = (entry: string, name: string) => {
    let dir = dirname(fileURLToPath(entry));
    for (;;) {
      const manifest = join(dir, "package.json");
      if (existsSync(manifest)) {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (parsed.name === name) return { dir, version: parsed.version ?? "" };
      }
      const parent = dirname(dir);
      if (parent === dir) throw new Error(`could not locate the ${name} package root`);
      dir = parent;
    }
  };

  const mcpi = packageRootOf(import.meta.resolve("@sammorrowdrums/mcpi"), "@sammorrowdrums/mcpi");
  hostVersion = mcpi.version;

  // mcpi ships a shrinkwrap, so its dependencies install nested rather than
  // hoisted. Prefer the nested copy — that is the build mcpi itself loads —
  // and fall back to the ordinary lookup chain if a future layout hoists it.
  let aiDir: string | undefined;
  for (let dir = mcpi.dir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "@sammorrowdrums", "mcpi-ai");
    if (existsSync(join(candidate, "package.json"))) {
      aiDir = candidate;
      break;
    }
    if (dirname(dir) === dir) break;
  }
  if (!aiDir) throw new Error("could not locate @sammorrowdrums/mcpi-ai beneath mcpi");
  const aiDist = join(aiDir, "dist");

  ({ splitDeferredTools } = (await import(
    pathToFileURL(join(aiDist, "utils", "deferred-tools.js")).href
  )) as { splitDeferredTools: SplitDeferredTools });
  ({ stream } = (await import(
    pathToFileURL(join(aiDist, "api", "anthropic-messages.js")).href
  )) as { stream: StreamFn });
  typesDeclaration = readFileSync(join(aiDist, "types.d.ts"), "utf8");
});

const noop = () => undefined;

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userTurn(text: string) {
  return { role: "user", content: [{ type: "text", text }], timestamp: 1 };
}

function assistantCall(id: string, name: string) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-opus-5",
    usage,
    stopReason: "toolUse",
    timestamp: 2,
    content: [{ type: "toolCall", id, name, arguments: {} }],
  };
}

/**
 * Shaped exactly like what `createLoadSkillTool` hands back once the host
 * wrapper has turned an `AgentToolResult` into a transcript message.
 */
function skillResult(id: string, addedToolNames?: string[], text = "skill body") {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: "load_skill",
    isError: false,
    timestamp: 3,
    content: [{ type: "text", text }],
    ...(addedToolNames ? { addedToolNames } : {}),
  };
}

function tool(name: string): HostTool {
  return {
    name,
    description: `${name} description`,
    parameters: { type: "object", properties: {} },
  };
}

/** The subset of a serialized Anthropic request these tests assert on. */
interface SerializedRequest {
  tools?: { name: string; defer_loading?: boolean }[];
  messages: { role: string; content: SerializedBlock[] }[];
}

interface SerializedBlock {
  type: string;
  text?: string;
  tool_use_id?: string;
  tool_name?: string;
  content?: SerializedBlock[];
}

/** Drive the published Anthropic converter and capture the serialized request. */
async function serialize(context: HostContext): Promise<SerializedRequest> {
  let captured: SerializedRequest | undefined;
  const fetch = async (_url: unknown, init: { body: string }) => {
    captured = JSON.parse(init.body) as SerializedRequest;
    return new Response(JSON.stringify({ type: "error", error: { message: "halt" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };

  const model = {
    id: "claude-opus-5",
    provider: "anthropic",
    name: "contract-fixture",
    api: "anthropic-messages",
    baseUrl: "https://example.invalid",
    input: ["text"],
    output: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { supportsToolReferences: true },
  };

  for await (const _event of stream(model, context, { fetch, apiKey: "contract-fixture" })) {
    // Drained so the request is built and sent; the fake fetch ends the stream.
  }
  if (!captured) throw new Error("published provider never issued a request");
  return captured;
}

describe("host activation contract (published mcpi)", () => {
  it("resolves the mcpi build under test", () => {
    expect(hostVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("declares the activation field as ToolResultMessage.addedToolNames?: string[]", () => {
    // The exact field name, on the exact interface. There is no alias, so a
    // rename upstream must fail here rather than degrade to a silent no-op.
    const toolResult = /export interface ToolResultMessage<[^>]*> \{([\s\S]*?)\n\}/.exec(
      typesDeclaration,
    );
    expect(toolResult, "ToolResultMessage not found in published types").not.toBeNull();
    expect(toolResult?.[1]).toContain("addedToolNames?: string[]");
  });

  it("defers exactly the names an activation marks", () => {
    const context: HostContext = {
      systemPrompt: "sys",
      tools: [tool("load_skill"), tool("search_issues"), tool("create_issue"), tool("unrelated")],
      messages: [
        userTurn("hi"),
        assistantCall("c1", "load_skill"),
        skillResult("c1", ["search_issues", "create_issue"]),
      ],
    };

    const { immediate, deferred } = splitDeferredTools(context, true);
    expect([...deferred.keys()]).toEqual(["search_issues", "create_issue"]);
    expect(immediate.map((t) => t.name)).toEqual(["load_skill", "unrelated"]);
  });

  it("omits the field entirely when a skill reveals nothing", () => {
    const context: HostContext = {
      systemPrompt: "sys",
      tools: [tool("load_skill"), tool("search_issues")],
      messages: [userTurn("hi"), assistantCall("c1", "load_skill"), skillResult("c1")],
    };

    // An absent field and an empty array are the same to the host, but only
    // the absent field keeps the wire clean, so `load_skill` omits it.
    expect(skillResult("c1")).not.toHaveProperty("addedToolNames");
    const { deferred } = splitDeferredTools(context, true);
    expect(deferred.size).toBe(0);
  });

  it("only un-defers a tool used *before* the activation that names it", () => {
    // The published split is a single forward pass: `usedNames` accumulates
    // as it walks, so a marker only loses to a call that already happened.
    // This is worth pinning precisely, because the intuitive reading — "a
    // used tool becomes immediate" — is order-independent and wrong.
    const used = (id: string, name: string) => [
      assistantCall(id, name),
      {
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        isError: false,
        timestamp: 4,
        content: [{ type: "text", text: "results" }],
      },
    ];

    const tools = [tool("load_skill"), tool("search_issues")];

    // Used first, then named: the definition is already in the transcript
    // with a real call against it, so deferring it would strand that call.
    const before = splitDeferredTools(
      {
        systemPrompt: "sys",
        tools,
        messages: [
          userTurn("hi"),
          ...used("c0", "search_issues"),
          assistantCall("c1", "load_skill"),
          skillResult("c1", ["search_issues"]),
        ],
      },
      true,
    );
    expect(before.deferred.size).toBe(0);
    expect(before.immediate.map((t) => t.name)).toContain("search_issues");

    // Named first, then used: it stays deferred. That is the case that
    // matters for us — the model reached the tool through the reference the
    // skill emitted, and the tools array does not change underneath it, so
    // the prompt prefix survives the call intact.
    const after = splitDeferredTools(
      {
        systemPrompt: "sys",
        tools,
        messages: [
          userTurn("hi"),
          assistantCall("c1", "load_skill"),
          skillResult("c1", ["search_issues"]),
          ...used("c2", "search_issues"),
        ],
      },
      true,
    );
    expect([...after.deferred.keys()]).toEqual(["search_issues"]);
  });

  it("leaves every tool immediate when the host has deferral switched off", () => {
    // A provider without tool_reference support must still see the whole
    // catalogue. Deferral is a transport optimisation, never a gate.
    const { immediate, deferred } = splitDeferredTools(
      {
        systemPrompt: "sys",
        tools: [tool("load_skill"), tool("search_issues")],
        messages: [
          userTurn("hi"),
          assistantCall("c1", "load_skill"),
          skillResult("c1", ["search_issues"]),
        ],
      },
      false,
    );
    expect(deferred.size).toBe(0);
    expect(immediate.map((t) => t.name)).toEqual(["load_skill", "search_issues"]);
  });

  it("keeps one tool immediate when every tool is marked", async () => {
    // The provider refuses a request whose entire tool array is deferred, so
    // it promotes them back. Worth pinning: it means a skill that reveals
    // everything silently disables deferral rather than breaking the turn.
    const context: HostContext = {
      systemPrompt: "sys",
      tools: [tool("only_a"), tool("only_b")],
      messages: [
        userTurn("hi"),
        assistantCall("c1", "load_skill"),
        skillResult("c1", ["only_a", "only_b"]),
      ],
    };

    const body = await serialize(context);
    for (const entry of body.tools ?? []) {
      expect(entry.defer_loading).toBeUndefined();
    }
  });

  it("serializes deferral and a single tool_reference at the original result", async () => {
    const body = await serialize({
      systemPrompt: "sys",
      tools: [tool("load_skill"), tool("search_issues")],
      messages: [
        userTurn("hi"),
        assistantCall("c1", "load_skill"),
        skillResult("c1", ["search_issues"], "skill body"),
      ],
    });

    const definitions = body.tools ?? [];
    expect(definitions.find((t) => t.name === "search_issues")?.defer_loading).toBe(true);
    expect(definitions.find((t) => t.name === "load_skill")?.defer_loading).toBeUndefined();

    const last = body.messages.at(-1);
    const toolResult = last?.content.find((b) => b.type === "tool_result");
    expect(toolResult?.tool_use_id).toBe("c1");
    // The reference sits where the result was, so the definition arrives at
    // the point in the transcript where the skill said it should.
    expect(toolResult?.content).toEqual([{ type: "tool_reference", tool_name: "search_issues" }]);
    // Anthropic rejects a tool_result that mixes references with other
    // content, so the body text is displaced to a sibling block.
    expect(last?.content.some((b) => b.type === "text" && b.text === "skill body")).toBe(true);
  });

  it("keeps the marker live across later turns and emits it only once", async () => {
    const body = await serialize({
      systemPrompt: "sys",
      tools: [tool("load_skill"), tool("search_issues")],
      messages: [
        userTurn("hi"),
        assistantCall("c1", "load_skill"),
        skillResult("c1", ["search_issues"]),
        userTurn("still here?"),
        assistantCall("c2", "load_skill"),
        skillResult("c2", ["search_issues"]),
      ],
    });

    const references = JSON.stringify(body.messages).split('"type":"tool_reference"').length - 1;
    expect(references).toBe(1);
    const definitions = body.tools ?? [];
    expect(definitions.find((t) => t.name === "search_issues")?.defer_loading).toBe(true);
  });

  it("sends no reference and no deferral when nothing was activated", async () => {
    const body = await serialize({
      systemPrompt: "sys",
      tools: [tool("load_skill"), tool("search_issues")],
      messages: [userTurn("hi"), assistantCall("c1", "load_skill"), skillResult("c1")],
    });

    expect(JSON.stringify(body.messages)).not.toContain("tool_reference");
    for (const entry of body.tools ?? []) {
      expect(entry.defer_loading).toBeUndefined();
    }
  });
});

/**
 * The half that matters most: our real `load_skill`, not a hand-written
 * fixture, driving the real published provider. Everything above pins the
 * host's side of the contract; this pins that we actually speak it.
 */
describe("load_skill output is consumed by the published provider", () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();
  const manager = new McpClientManager({ transportFactory: () => clientTransport });
  const registry = new SkillRegistry();
  const confirm = vi.fn().mockResolvedValue(true);
  const policy = new McpPolicy({ gateway: manager, approvals: { confirm } });

  beforeAll(async () => {
    await server.connect(serverTransport);
    await manager.connectAll({
      mcpServers: {
        "test-weather": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/weather-stdio.js"],
        },
      },
    });
    const skills = await discoverSkillsFromServer(policy, "test-weather", noop);
    registry.registerAll(skills);
    policy.registerSkills(skills);
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close()]);
  });

  it("reveals its tools through the host's activation channel end to end", async () => {
    const loadSkill = createLoadSkillTool({ registry, policy });
    const result = await loadSkill.execute(
      "call-1",
      { name: "weather" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
    );

    expect(result.addedToolNames).toBeDefined();
    expect(result.addedToolNames?.length).toBeGreaterThan(0);
    // Nothing was asked. Revealing a definition is not an authorization.
    expect(confirm).not.toHaveBeenCalled();

    const revealed = result.addedToolNames ?? [];
    const catalogue = [tool("load_skill"), ...revealed.map(tool), tool("never_revealed")];

    const body = await serialize({
      systemPrompt: "sys",
      tools: catalogue,
      messages: [
        userTurn("what is the weather"),
        assistantCall("call-1", "load_skill"),
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "load_skill",
          isError: false,
          timestamp: 3,
          content: result.content,
          ...(result.addedToolNames ? { addedToolNames: result.addedToolNames } : {}),
        },
      ],
    });

    const definitions = body.tools ?? [];
    for (const name of revealed) {
      expect(definitions.find((t) => t.name === name)?.defer_loading).toBe(true);
    }
    // A tool the skill never named is untouched by activation.
    expect(definitions.find((t) => t.name === "never_revealed")?.defer_loading).toBeUndefined();

    const references = (body.messages.at(-1)?.content ?? [])
      .filter((b) => b.type === "tool_result")
      .flatMap((b) => b.content ?? [])
      .filter((b) => b.type === "tool_reference")
      .map((b) => b.tool_name);
    // Same names, same order, emitted once, at the point the skill loaded.
    expect(references).toEqual(revealed);
  });
});
