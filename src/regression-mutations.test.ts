import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { McpClientManager } from "./mcp/client-manager.js";
import {
  McpPolicy,
  isReadOnlyToolCall,
  type McpCallSource,
  type McpPolicySkill,
} from "./mcp/policy.js";
import type { McpTool } from "./mcp/index.js";
import { createWeatherServer } from "./test-servers/weather-server.js";
import { SkillRegistry } from "./skills/skill-registry.js";
import { discoverSkillsFromServer } from "./skills/discover.js";
import { createLoadSkillTool } from "./skills/load-skill-tool.js";
import { createPolicyToolProvider } from "./tool-cli/provider.js";
import { isSkillsExtensionEnabled } from "./mcp/config.js";

/**
 * Negative tests by mutation.
 *
 * Every other test in this change asserts what the corrected design does. That
 * is necessary and not sufficient: a test only earns its place if it would
 * fail when the bug comes back. So this file writes the old behaviour down as
 * executable mutants, runs the same fixtures through both, and asserts they
 * disagree at the exact point that mattered.
 *
 * The mutants are deliberately faithful and deliberately plausible. Each one
 * looked like a safety measure when it was written. That is precisely why they
 * need to be pinned as wrong rather than merely absent: "no approval before a
 * write" and "no gate before a call" read as the same sentence to a future
 * reviewer, and only one of them is the bug.
 */

/** The old rule: code mode could see a write tool but never run one. */
function mutantCodeModeDenial(source: McpCallSource, tool: McpTool): "denied" | "dispatched" {
  if (source === "code-mode" && !isReadOnlyToolCall(tool)) return "denied";
  return "dispatched";
}

/** The old rule: a skill-gated tool was refused on every surface, not just the direct one. */
function mutantSkillGate(
  source: McpCallSource,
  toolName: string,
  gated: ReadonlySet<string>,
  activeGrants: ReadonlySet<string>,
): "tool_gated" | "dispatched" {
  void source;
  if (gated.has(toolName) && !activeGrants.has(toolName)) return "tool_gated";
  return "dispatched";
}

/** The old rule: SEP-2640 negotiation was off unless the user passed the opt-in flag. */
function mutantSkillsExtensionEnabled(config: {
  experimental?: { skillsExtension?: boolean };
}): boolean {
  return config.experimental?.skillsExtension === true;
}

/** A bare skill reference, so a test can activate an exposure set directly. */
function skillReference(
  name: string,
  serverName: string,
  referencedTools: readonly string[],
): McpPolicySkill {
  return { name, serverName, uri: `skill://${name}`, referencedTools };
}

/** Invoke `load_skill` through its real host signature. */
async function runLoadSkill(
  tool: ReturnType<typeof createLoadSkillTool>,
  name: string,
): ReturnType<ReturnType<typeof createLoadSkillTool>["execute"]> {
  return tool.execute(`call-${name}`, { name }, undefined, undefined, {
    // The handler never touches the extension context on these paths.
    ...{},
  } as Parameters<ReturnType<typeof createLoadSkillTool>["execute"]>[4]);
}

describe("negative tests: the corrected semantics disagree with the old behaviour", () => {
  const [weatherClient, weatherServerTransport] = InMemoryTransport.createLinkedPair();
  const [ledgerClient, ledgerServerTransport] = InMemoryTransport.createLinkedPair();
  const server = createWeatherServer();

  const ledger = new McpServer(
    { name: "test-ledger", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  ledger.registerTool(
    "record_observation",
    {
      description: "Append a weather observation to the ledger",
      inputSchema: { city: z.string(), note: z.string() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ city, note }) => ({
      content: [{ type: "text" as const, text: `recorded ${city}: ${note}` }],
    }),
  );

  const manager = new McpClientManager({
    transportFactory: (config) =>
      config.type === "stdio" && config.args?.[0]?.includes("ledger")
        ? ledgerClient
        : weatherClient,
  });
  const registry = new SkillRegistry();
  const confirm = vi.fn().mockResolvedValue(true);
  const policy = new McpPolicy({ gateway: manager, approvals: { confirm } });

  const skillTools = ["check_weather_for_city", "check_weekly_forecast_for_city"];

  beforeAll(async () => {
    await Promise.all([
      server.connect(weatherServerTransport),
      ledger.connect(ledgerServerTransport),
    ]);
    await manager.connectAll({
      mcpServers: {
        "test-weather": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/weather-stdio.js"],
        },
        "test-ledger": {
          type: "stdio",
          command: "node",
          args: ["dist/test-servers/ledger-stdio.js"],
        },
      },
    });
    const skills = await discoverSkillsFromServer(policy, "test-weather", () => undefined);
    registry.registerAll(skills);
    policy.registerSkills(skills);
  });

  afterAll(async () => {
    await Promise.all([manager.disconnectAll(), server.close(), ledger.close()]);
  });

  const writeTool = (): McpTool => {
    const tool = policy
      .getDiscoverableTools("test-ledger")
      .find((t) => t.name === "record_observation");
    if (!tool) throw new Error("ledger write tool missing from the discovered set");
    return tool;
  };

  describe("mutant 1: code mode refusing writes outright", () => {
    it("the mutant denies the write the real policy asks about and performs", async () => {
      confirm.mockClear();
      const tool = writeTool();

      // The mutant's verdict, on the same tool, from the same source.
      expect(mutantCodeModeDenial("code-mode", tool)).toBe("denied");

      const result = await policy.callTool({
        source: "code-mode",
        serverName: "test-ledger",
        toolName: "record_observation",
        args: { city: "London", note: "mutation check" },
      });

      // The real boundary asks, and on approval it dispatches. Divergence
      // proven: the mutant never reaches the server and never asks.
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(result.result.isError).toBeFalsy();
    });

    it("refusing to prompt is what made the mutant wrong, not refusing to run", async () => {
      // Stated precisely, because the two are easy to conflate. The bug was
      // never "code mode ran a write". It was that the decision was taken
      // without the user, so a denial could not be reconsidered and an
      // approval could not be given.
      confirm.mockClear();
      confirm.mockResolvedValueOnce(false);

      const declined = policy.callTool({
        source: "code-mode",
        serverName: "test-ledger",
        toolName: "record_observation",
        args: { city: "London", note: "declined" },
      });

      // The decline surfaces as a legible refusal that names the tool and says
      // how to proceed, not as a bare failure the script has to guess at.
      await expect(declined).rejects.toThrow(/record_observation/);
      await expect(declined).rejects.toThrow(/declined/);
      await expect(declined).rejects.toThrow(/approve the prompt/);
      expect(confirm).toHaveBeenCalledTimes(1);

      // A decline still leaves one record, and the mutant's silent denial
      // would have produced the same record with nobody consulted. The
      // difference is the prompt, so the prompt is what the test asserts.
      const records = policy
        .getAuditLog()
        .filter((r) => r.operation === "tool" && r.toolName === "record_observation");
      expect(records.filter((r) => r.decision === "denied")).toHaveLength(1);
    });

    it("the mutant would have been right about a read, which is why it survived so long", () => {
      const read = policy
        .getDiscoverableTools("test-weather")
        .find((t) => t.name === "check_weather_for_city");
      if (!read) throw new Error("read tool missing");
      // Agreeing on the common case is exactly how a wrong rule hides. Pinning
      // the agreement makes the disagreement above the whole of the claim.
      expect(mutantCodeModeDenial("code-mode", read)).toBe("dispatched");
      expect(isReadOnlyToolCall(read)).toBe(true);
    });
  });

  describe("mutant 2: the skill gate applied to every surface", () => {
    const gated = new Set(skillTools);
    const noGrants = new Set<string>();

    it("the mutant blocks tool-cli where the real provider dispatches", async () => {
      expect(mutantSkillGate("tool-cli", skillTools[0], gated, noGrants)).toBe("tool_gated");

      const provider = createPolicyToolProvider(policy);
      const result = await provider.callTool("test-weather", skillTools[0], { city: "Tokyo" });
      expect(result.isError).toBeFalsy();
    });

    it("the mutant blocks code mode where the real policy dispatches", async () => {
      expect(mutantSkillGate("code-mode", skillTools[0], gated, noGrants)).toBe("tool_gated");

      const result = await policy.callTool({
        source: "code-mode",
        serverName: "test-weather",
        toolName: skillTools[0],
        args: { city: "Tokyo" },
      });
      expect(result.result.isError).toBeFalsy();
    });

    it("the mutant hides from discovery what the real catalogue lists", () => {
      // Worse than the refusal: under the mutant the sandbox could not even
      // find the tool, so the failure had no legible cause. Discovery is the
      // half that has to be asserted separately.
      const discovered = policy.getDiscoverableTools("test-weather").map((t) => t.name);
      for (const name of skillTools) {
        expect(discovered).toContain(name);
        expect(mutantSkillGate("code-mode", name, gated, noGrants)).toBe("tool_gated");
      }
    });

    it("keeps the one thing the mutant got right: deferral on the direct surface", () => {
      // The mutant was not wrong that these tools start hidden from the model.
      // It was wrong that hidden meant forbidden. Deleting the gate must not
      // delete the deferral, so this asserts the corrected half still holds.
      for (const name of skillTools) expect(policy.isDeferred(name)).toBe(true);
    });
  });

  describe("mutant 3: revealing definitions behind an approval prompt", () => {
    it("loading a skill asks nothing, where the mutant would have prompted", async () => {
      confirm.mockClear();
      const loadSkill = createLoadSkillTool({ registry, policy });
      const skill = registry.getAll()[0];

      const result = await runLoadSkill(loadSkill, skill.name);

      // The mutant is the absence of this assertion: an approval-gated reveal
      // is indistinguishable from an approval-gated call at the call site, and
      // that conflation is the whole bug. Reading a procedure is not doing
      // anything, so nothing may be asked.
      expect(confirm).not.toHaveBeenCalled();
      expect(result.addedToolNames?.length ?? 0).toBeGreaterThan(0);
    });

    it("activation names only tools that exist, and reports the rest as diagnostics", () => {
      // The old grant keyed on the declared list, so a name that matched
      // nothing still widened authority. Now an unmatched name reveals
      // nothing and is surfaced for the server author to fix.
      const outcome = policy.activateSkillReference(
        skillReference("phantom", "test-weather", ["check_weather_for_city", "no_such_tool"]),
      );

      expect(outcome.referencedTools).toContain("check_weather_for_city");
      expect(outcome.referencedTools).not.toContain("no_such_tool");
      expect(outcome.unresolvedTools).toContain("no_such_tool");
    });

    it("an activated tool is still subject to approval when it actually runs", async () => {
      // The most dangerous reading of "activation is not approval" is that
      // activation grants nothing and therefore costs nothing to widen. The
      // load-bearing consequence is the opposite: because activation is only
      // exposure, execution must still be decided at execution.
      confirm.mockClear();
      policy.activateSkillReference(
        skillReference("ledger-writer", "test-ledger", ["record_observation"]),
      );

      const result = await policy.callTool({
        source: "proxy",
        serverName: "test-ledger",
        toolName: "record_observation",
        args: { city: "Tokyo", note: "post-activation" },
      });

      expect(confirm).toHaveBeenCalledTimes(1);
      expect(result.result.isError).toBeFalsy();
    });
  });

  describe("mutant 4: SEP-2640 negotiation behind an opt-in flag", () => {
    const cases: { label: string; config: { experimental?: { skillsExtension?: boolean } } }[] = [
      { label: "no config at all", config: {} },
      { label: "an empty experimental block", config: { experimental: {} } },
      { label: "the key left undefined", config: { experimental: { skillsExtension: undefined } } },
    ];

    for (const { label, config } of cases) {
      it(`negotiates with ${label} where the mutant stays silent`, () => {
        expect(isSkillsExtensionEnabled(config)).toBe(true);
        expect(mutantSkillsExtensionEnabled(config)).toBe(false);
      });
    }

    it("agrees with the mutant only when the user explicitly opts out", () => {
      const off = { experimental: { skillsExtension: false } };
      expect(isSkillsExtensionEnabled(off)).toBe(false);
      expect(mutantSkillsExtensionEnabled(off)).toBe(false);
    });
  });

  describe("mutant 5: activation carried in a details field the host never reads", () => {
    it("puts the names on the field the host consumes, not beside it", async () => {
      const loadSkill = createLoadSkillTool({ registry, policy });
      const skill = registry.getAll()[0];
      const result = await runLoadSkill(loadSkill, skill.name);

      // `details.referencedTools` is diagnostic. The host reads
      // `addedToolNames`. The old code populated only the former, which is
      // why activation was a silent no-op that looked correct in every log.
      const details = result.details as { referencedTools?: string[] } | undefined;
      expect(details?.referencedTools?.length).toBeGreaterThan(0);
      expect(result.addedToolNames).toEqual(details?.referencedTools);

      // The mutant: reading the diagnostic field as if it were the channel.
      const mutantActivation = (result as { activatedTools?: string[] }).activatedTools;
      expect(mutantActivation).toBeUndefined();
    });
  });
});
