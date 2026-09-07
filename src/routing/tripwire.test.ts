import { describe, it, expect } from "vitest";
import { detectToolCliTripwires, type AssistantTurn } from "./tripwire.js";

/** A real invocation: the bash tool actually ran the command. */
const realCall = [{ name: "bash", arguments: { command: "tool-cli weather get_forecast '{}'" } }];

function codes(turn: AssistantTurn): string[] {
  return detectToolCliTripwires(turn).map((finding) => finding.code);
}

describe("tool-cli anti-hallucination tripwire", () => {
  describe("pseudo-calls", () => {
    it("trips on assistant text containing <tool_cli with no real tool call", () => {
      // The regression this whole section exists to prevent: the agent treats
      // the documentation tag as an invocation syntax.
      const findings = detectToolCliTripwires({
        text: "Let me check the forecast.\n\n<tool_cli>weather get_forecast</tool_cli>\n\nIt is 22°C and sunny.",
      });

      expect(findings.map((f) => f.code)).toContain("tool_cli_pseudo_call");
      const pseudo = findings.find((f) => f.code === "tool_cli_pseudo_call");
      expect(pseudo?.evidence).toContain("tool_cli");
      expect(pseudo?.message).toContain("never by emitting XML");
    });

    it("trips on the renamed documentation tag too", () => {
      expect(codes({ text: "I'll use <tool_cli_usage_docs> to fetch that." })).toContain(
        "tool_cli_pseudo_call",
      );
    });

    it("trips on hyphenated and closing variants", () => {
      expect(codes({ text: "</tool-cli>" })).toContain("tool_cli_pseudo_call");
      expect(codes({ text: "< tool_cli >" })).toContain("tool_cli_pseudo_call");
    });
  });

  describe("narrated invocations", () => {
    it("trips when a command is written out but never run", () => {
      const findings = detectToolCliTripwires({
        text: "Running:\n\n$ tool-cli --help\n\nIt lists two servers, weather and echo.",
      });

      expect(findings.map((f) => f.code)).toContain("tool_cli_narrated_without_bash");
      const narrated = findings.find((f) => f.code === "tool_cli_narrated_without_bash");
      expect(narrated?.message).toContain("fabricated rather than observed");
    });

    it("trips on a bare command line with no shell prompt", () => {
      expect(codes({ text: "tool-cli weather get_forecast '{}'" })).toContain(
        "tool_cli_narrated_without_bash",
      );
      expect(codes({ text: "tool-cli weather list --json" })).toContain(
        "tool_cli_narrated_without_bash",
      );
    });

    it("reports both failure modes when text does both", () => {
      const found = codes({
        text: "<tool_cli>x</tool_cli>\n$ tool-cli weather list\nThe result was 22°C.",
      });
      expect(found).toContain("tool_cli_pseudo_call");
      expect(found).toContain("tool_cli_narrated_without_bash");
    });
  });

  describe("grounded usage", () => {
    it("clears both tripwires when the bash tool really ran tool-cli", () => {
      expect(
        detectToolCliTripwires({
          text: "I ran `tool-cli weather get_forecast '{}'`, which returned 22°C.",
          toolCalls: realCall,
        }),
      ).toEqual([]);
    });

    it("clears even markup-shaped text once a real call exists", () => {
      // Grounded output is grounded regardless of how the agent formats it.
      expect(
        detectToolCliTripwires({ text: "<tool_cli_usage_docs>", toolCalls: realCall }),
      ).toEqual([]);
    });

    it("stays quiet on text that never mentions an invocation", () => {
      // Prose about the program is not a transcript of running it.
      expect(detectToolCliTripwires({ text: "tool-cli is available this session." })).toEqual([]);
      expect(
        detectToolCliTripwires({ text: "tool-cli is a program you run with the bash tool" }),
      ).toEqual([]);
      expect(detectToolCliTripwires({ text: "No MCP servers are connected." })).toEqual([]);
    });
  });

  describe("what counts as a real call", () => {
    it("does not accept a non-shell tool that merely mentions tool-cli", () => {
      expect(
        codes({
          text: "<tool_cli>x</tool_cli>",
          toolCalls: [{ name: "view", arguments: { command: "tool-cli --help" } }],
        }),
      ).toContain("tool_cli_pseudo_call");
    });

    it("does not accept a bash call that ran something else", () => {
      expect(
        codes({
          text: "$ tool-cli --help",
          toolCalls: [{ name: "bash", arguments: { command: "ls -la" } }],
        }),
      ).toContain("tool_cli_narrated_without_bash");
    });

    it("honours a configured shell tool name", () => {
      const turn: AssistantTurn = {
        text: "$ tool-cli --help",
        toolCalls: [{ name: "shell", arguments: { command: "tool-cli --help" } }],
      };

      expect(detectToolCliTripwires(turn)).not.toEqual([]);
      expect(detectToolCliTripwires(turn, { bashToolNames: ["shell"] })).toEqual([]);
    });
  });
});
