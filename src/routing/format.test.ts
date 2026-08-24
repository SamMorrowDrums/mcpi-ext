import { describe, it, expect } from "vitest";
import {
  buildExecutionFacilities,
  FACILITY_ORDER,
  type ExecutionRoutingState,
} from "./facilities.js";
import { EXECUTION_ROUTING_TAG, formatExecutionRouting } from "./format.js";

/** Everything working: skills discovered, RPC up, shell registered. */
function fullState(): ExecutionRoutingState {
  return {
    skills: { count: 3, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: { kind: "started", port: 51234 },
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

    it("advertises tool-cli only after the RPC server starts", () => {
      const started = buildExecutionFacilities(fullState()).find((f) => f.id === "tool_cli");
      expect(started?.availability.state).toBe("available");
      expect(started?.availability.detail).toContain("started on port 51234");

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
      expect(toolCli?.availability.detail).toContain("tell the user about this startup failure");
    });

    it("reports bash from host tool registration", () => {
      const registered = buildExecutionFacilities(fullState()).find((f) => f.id === "bash");
      expect(registered?.availability.state).toBe("available");
      expect(registered?.availability.detail).toContain('host "bash" tool is registered');

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
      expect(toolCli?.availability.detail).toContain("no host bash tool is registered");
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
