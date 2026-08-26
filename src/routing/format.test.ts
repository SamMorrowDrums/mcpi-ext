import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";
import { describe, it, expect } from "vitest";
import {
  buildExecutionFacilities,
  FACILITY_ORDER,
  type ExecutionRoutingState,
} from "./facilities.js";
import { EXECUTION_ROUTING_TAG, formatExecutionRouting } from "./format.js";

const VERIFIED_BRIDGE_INFO: BridgeInfo = {
  bridgeProtocol: { name: "tool-cli-bridge", major: 1, version: "1.0" },
  serverImplementation: { name: "@sammorrowdrums/tool-cli", version: "1.0.0" },
  operations: [
    "getBridgeInfo",
    "listServers",
    "listTools",
    "describeTool",
    "callTool",
    "listResources",
    "listResourceTemplates",
    "readResource",
  ],
  capabilities: {
    authentication: { required: true, scheme: "bearer" },
    tools: {
      discovery: true,
      calls: true,
      inputSchemaValidation: true,
      jsonSchemaDialect: "https://json-schema.org/draft/2020-12/schema",
      supportedJsonSchemaDialects: [
        "https://json-schema.org/draft/2020-12/schema",
        "https://json-schema.org/draft/2019-09/schema",
        "http://json-schema.org/draft-07/schema#",
      ],
    },
    resources: { list: true, templates: true, read: true },
    cancellation: { providerAbortSignal: true },
  },
  upstreamMcp: { serverCount: 2 },
};

/** Everything working: skills discovered, authenticated bridge verified, shell active. */
function fullState(): ExecutionRoutingState {
  return {
    skills: { count: 3, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: { kind: "verified", port: 51234, bridgeInfo: VERIFIED_BRIDGE_INFO },
    bash: { kind: "registered", toolName: "bash" },
  };
}

/** The bare load: no config, no servers, nothing discovered. */
function zeroServerState(): ExecutionRoutingState {
  return {
    skills: { count: 0, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: {
      kind: "not_started",
      reason: "no MCP servers are configured, so there is nothing for it to expose",
    },
    bash: { kind: "registered", toolName: "bash" },
  };
}

describe("execution routing section", () => {
  describe("emission", () => {
    it("is emitted with zero MCP servers", () => {
      const result = formatExecutionRouting(zeroServerState());
      expect(result).toContain(`<${EXECUTION_ROUTING_TAG}>`);
      expect(result).toContain(`</${EXECUTION_ROUTING_TAG}>`);
      expect(result.trim().length).toBeGreaterThan(0);
    });

    it("describes all four facilities even when most are unavailable", () => {
      const result = formatExecutionRouting(zeroServerState());
      expect(result).toContain("bash and external programs");
      expect(result).toContain("Code mode");
      expect(result).toContain("Skills");
      expect(result).toContain("tool-cli");
    });

    it("emits exactly one routing section", () => {
      const result = formatExecutionRouting(fullState());
      expect(result.split(`<${EXECUTION_ROUTING_TAG}>`)).toHaveLength(2);
      expect(result.split(`</${EXECUTION_ROUTING_TAG}>`)).toHaveLength(2);
    });
  });

  describe("facility descriptions", () => {
    it("leads every facility with intent", () => {
      const facilities = buildExecutionFacilities(fullState());
      expect(facilities).toHaveLength(4);
      for (const facility of facilities) {
        expect(facility.useWhen.startsWith("Use when")).toBe(true);
      }
    });

    it("describes skills as domain workflow guidance", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("domain workflow");
      expect(result).toContain("load_skill");
    });

    it("states skills enable declared tools only after approval", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("enabled only after you approve the grant");
      expect(result).toContain("leaves every gated tool locked");
    });

    it("describes code mode as sandboxed exact computation with no fs/net/process", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("exact computation");
      expect(result).toContain("sandboxed V8 isolate");
      expect(result).toContain("Filesystem access. There is no fs");
      expect(result).toContain("Network access. There is no fetch");
      expect(result).toContain("Process access. There is no process");
    });

    it("describes tool-cli as an MCP-to-shell on-ramp run through the bash tool", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("MCP-to-shell on-ramp");
      expect(result).toContain("invoked through the host bash tool");
      expect(result).toContain("tool-cli is a program you run with the bash tool");
    });

    it("describes bash as the filesystem and artifact substrate", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("reading or writing files");
      expect(result).toContain(
        "the only facility that can create, modify, or inspect files and artifacts",
      );
    });

    it("explains that tool-cli and bash compose in one command", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("Composing facilities");
      expect(result).toContain("single bash command rather than two rival");
    });
  });

  describe("availability reporting", () => {
    it("always states an availability line for every facility", () => {
      const result = formatExecutionRouting(zeroServerState());
      const availabilityLines = result
        .split("\n")
        .filter((line) => line.startsWith("Availability: "));
      expect(availabilityLines).toHaveLength(4);
      for (const line of availabilityLines) {
        // state plus a non-empty reason, never a bare verdict
        expect(line).toMatch(/^Availability: (available|unavailable|unknown) — .+/);
      }
    });

    it("keeps code mode available with zero MCP servers", () => {
      const facilities = buildExecutionFacilities(zeroServerState());
      const codeMode = facilities.find((f) => f.id === "code_mode");
      expect(codeMode?.availability.state).toBe("available");
      expect(codeMode?.availability.detail).toContain("Available with zero MCP servers connected");
    });

    it("reports skill count and draft extension status", () => {
      const withSkills = formatExecutionRouting(fullState());
      expect(withSkills).toContain("3 MCP skill(s) discovered");
      expect(withSkills).toContain("Draft SEP-2640 skills extension: disabled.");

      const draftOn = formatExecutionRouting({
        ...fullState(),
        skills: { count: 1, draftExtensionEnabled: true },
      });
      expect(draftOn).toContain("1 MCP skill(s) discovered");
      expect(draftOn).toContain("enabled (unratified draft)");
    });

    it("reports skills unavailable, with a reason, when none were discovered", () => {
      const facilities = buildExecutionFacilities(zeroServerState());
      const skills = facilities.find((f) => f.id === "skills");
      expect(skills?.availability.state).toBe("unavailable");
      expect(skills?.availability.detail).toContain("No MCP skills were discovered");
    });

    it("advertises tool-cli only after a compatible authenticated handshake", () => {
      const verified = buildExecutionFacilities(fullState()).find((f) => f.id === "tool_cli");
      expect(verified?.availability.state).toBe("available");
      expect(verified?.availability.detail).toContain("started on port 51234");
      expect(verified?.availability.detail).toContain(
        "authenticated tool-cli-bridge v1.0 handshake",
      );
      expect(verified?.availability.detail).toContain("@sammorrowdrums/tool-cli@1.0.0");

      const notStarted = buildExecutionFacilities(zeroServerState()).find(
        (f) => f.id === "tool_cli",
      );
      expect(notStarted?.availability.state).toBe("unavailable");
      expect(notStarted?.availability.detail).toContain("was not started");
    });

    it("surfaces an RPC startup failure actionably rather than swallowing it", () => {
      const facilities = buildExecutionFacilities({
        ...fullState(),
        toolCli: { kind: "failed", reason: "EADDRINUSE: port already bound" },
      });
      const toolCli = facilities.find((f) => f.id === "tool_cli");
      expect(toolCli?.availability.state).toBe("unavailable");
      // the actual error, plus what to do about it
      expect(toolCli?.availability.detail).toContain("EADDRINUSE: port already bound");
      expect(toolCli?.availability.detail).toContain("report this failure");
    });

    it("surfaces bridge incompatibility and keeps credentials unexposed", () => {
      const facilities = buildExecutionFacilities({
        ...fullState(),
        toolCli: {
          kind: "incompatible",
          reason: "expected tool-cli-bridge major 1, received major 2",
        },
      });
      const toolCli = facilities.find((f) => f.id === "tool_cli");
      expect(toolCli?.availability.state).toBe("unavailable");
      expect(toolCli?.availability.detail).toContain("received major 2");
      expect(toolCli?.availability.detail).toContain(
        "TOOL_CLI_PORT and TOOL_CLI_TOKEN were not exposed",
      );
    });

    it("reports no-bash startup suppression explicitly", () => {
      const facilities = buildExecutionFacilities({
        ...fullState(),
        toolCli: { kind: "no_bash", reason: "no host bash tool is registered" },
        bash: { kind: "absent" },
      });
      const toolCli = facilities.find((f) => f.id === "tool_cli");
      expect(toolCli?.availability.state).toBe("unavailable");
      expect(toolCli?.availability.detail).toContain("was not started");
      expect(toolCli?.availability.detail).toContain("No bridge credentials were exposed");
    });

    it("reports bash from host tool registration", () => {
      const registered = buildExecutionFacilities(fullState()).find((f) => f.id === "bash");
      expect(registered?.availability.state).toBe("available");
      expect(registered?.availability.detail).toContain('host "bash" tool is active');

      const absent = buildExecutionFacilities({
        ...fullState(),
        bash: { kind: "absent" },
      }).find((f) => f.id === "bash");
      expect(absent?.availability.state).toBe("unavailable");
    });

    it("reports unknown rather than guessing when the tool registry is unreadable", () => {
      const facilities = buildExecutionFacilities({
        ...fullState(),
        bash: { kind: "undiscoverable", reason: "getAllTools is not a function" },
      });
      const bash = facilities.find((f) => f.id === "bash");
      expect(bash?.availability.state).toBe("unknown");
      expect(bash?.availability.detail).toContain("getAllTools is not a function");
      const toolCli = facilities.find((f) => f.id === "tool_cli");
      expect(toolCli?.availability.state).toBe("unavailable");
      expect(toolCli?.availability.detail).toContain("current bash availability is unconfirmed");
    });

    it("marks tool-cli unavailable when no shell can run it", () => {
      // A healthy RPC server is unreachable without a shell; calling it
      // "available" would be untrue.
      const facilities = buildExecutionFacilities({
        ...fullState(),
        bash: { kind: "absent" },
      });
      const toolCli = facilities.find((f) => f.id === "tool_cli");
      expect(toolCli?.availability.state).toBe("unavailable");
      expect(toolCli?.availability.detail).toContain("no host bash tool is active");
    });

    it("never silently omits an unavailable facility", () => {
      const result = formatExecutionRouting({
        skills: { count: 0, draftExtensionEnabled: false },
        codeMode: { active: false },
        toolCli: { kind: "failed", reason: "boom" },
        bash: { kind: "absent" },
      });
      expect(result).toContain("Skills");
      expect(result).toContain("Code mode");
      expect(result).toContain("tool-cli");
      expect(result).toContain("bash and external programs");
      expect(result.match(/^Availability: unavailable/gm)).toHaveLength(4);
    });
  });

  describe("determinism", () => {
    it("orders facilities by FACILITY_ORDER", () => {
      const ids = buildExecutionFacilities(fullState()).map((f) => f.id);
      expect(ids).toEqual([...FACILITY_ORDER]);
    });

    it("keeps the same order regardless of availability", () => {
      const ids = buildExecutionFacilities({
        skills: { count: 0, draftExtensionEnabled: true },
        codeMode: { active: false },
        toolCli: { kind: "failed", reason: "boom" },
        bash: { kind: "undiscoverable", reason: "no registry" },
      }).map((f) => f.id);
      expect(ids).toEqual([...FACILITY_ORDER]);
    });

    it("is byte-stable across separate builds of equal state", () => {
      // Distinct object identities, equal values: the rendered bytes must match
      // so the prompt does not churn between turns.
      expect(formatExecutionRouting(fullState())).toBe(formatExecutionRouting(fullState()));
      expect(formatExecutionRouting(zeroServerState())).toBe(
        formatExecutionRouting(zeroServerState()),
      );
    });
  });

  describe("no contradictions", () => {
    const banned = [
      "prefer the skill",
      "prefer a skill",
      "skills first",
      "skill-first",
      "first choice",
      "last resort",
      "in order of preference",
      "fall back to",
      "always use",
    ];

    it("asserts no precedence between facilities", () => {
      const result = formatExecutionRouting(fullState()).toLowerCase();
      for (const phrase of banned) {
        expect(result).not.toContain(phrase);
      }
    });

    it("says explicitly that the order is not a ranking", () => {
      const result = formatExecutionRouting(fullState());
      expect(result).toContain("not by");
      expect(result).toContain("none of them is a default");
      expect(result).toContain("no sequence to try them in");
    });

    it("tells the agent not to fabricate output from an unavailable facility", () => {
      const result = formatExecutionRouting(zeroServerState());
      expect(result).toContain("never describe or summarise output it did not produce");
    });
  });

  describe("no internal labels", () => {
    const banned = [
      "sandman",
      "skill dealer",
      "nuclear football",
      "codey",
      "tier 1",
      "tier 2",
      "tier 3",
      "experiment",
      "arm a",
      "arm b",
      "variant",
      "treatment",
      "control group",
      "baseline",
      "pde",
    ];

    it("contains no experiment labels or personas", () => {
      const states = [fullState(), zeroServerState()];
      for (const state of states) {
        const result = formatExecutionRouting(state).toLowerCase();
        for (const phrase of banned) {
          expect(result).not.toContain(phrase);
        }
      }
    });
  });
});
