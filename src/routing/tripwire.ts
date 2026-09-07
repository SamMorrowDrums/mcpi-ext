/**
 * Anti-hallucination tripwire for tool-cli.
 *
 * tool-cli is a program, not a callable tool. The failure mode this guards
 * against is an agent that "invokes" it by writing markup or a shell transcript
 * into its own message and then narrates output that no process ever produced.
 * Both halves are wrong, and both are cheap to detect: a real invocation always
 * leaves a bash tool call whose command mentions `tool-cli`.
 *
 * The detector is deliberately strict. Mentioning the `<tool_cli_usage_docs>`
 * tag in prose without a real call trips it, because that is exactly the
 * confusion — treating the documentation tag as an invocation syntax — the
 * routing prompt is written to prevent.
 */

/** A tool call as observed on an assistant turn. */
export interface ObservedToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/** The assistant output under inspection. */
export interface AssistantTurn {
  text: string;
  toolCalls?: readonly ObservedToolCall[];
}

export type TripwireCode = "tool_cli_pseudo_call" | "tool_cli_narrated_without_bash";

export interface TripwireFinding {
  code: TripwireCode;
  /** The offending excerpt, so a failure message can point at it. */
  evidence: string;
  message: string;
}

export interface TripwireOptions {
  /** Host tool names that actually execute shell commands. */
  bashToolNames?: readonly string[];
}

const DEFAULT_BASH_TOOL_NAMES: readonly string[] = ["bash"];

/** `<tool_cli`, `</tool-cli`, `< tool_cli_usage_docs`, and friends. */
const PSEUDO_CALL_PATTERN = /<\s*\/?\s*tool[_-]cli[\w-]*/i;

/**
 * Lines that read like a shell transcript rather than prose.
 *
 * Two shapes qualify, and both are deliberately narrow so ordinary sentences
 * such as "tool-cli is available this session." are not mistaken for commands:
 * a line carrying an explicit shell prompt, or a line that opens with the
 * program and goes on to use recognisably CLI syntax — a flag, a quoted
 * argument, or a JSON brace.
 */
const NARRATED_INVOCATION_PATTERNS: readonly RegExp[] = [
  /^[ \t]*[$>][ \t]*tool-cli[ \t]+\S/m,
  /^[ \t]*tool-cli[ \t]+\S.*(?:--?[A-Za-z]|['"{}])/m,
];

function commandOf(call: ObservedToolCall): string {
  const command = call.arguments?.command;
  return typeof command === "string" ? command : "";
}

function hasRealToolCliCall(turn: AssistantTurn, bashToolNames: readonly string[]): boolean {
  return (turn.toolCalls ?? []).some(
    (call) => bashToolNames.includes(call.name) && commandOf(call).includes("tool-cli"),
  );
}

function excerpt(text: string, pattern: RegExp): string {
  const match = pattern.exec(text);
  if (!match) {
    return "";
  }
  const start = Math.max(0, match.index - 20);
  return text.slice(start, match.index + match[0].length + 60).trim();
}

/** The first narration pattern that matches, or undefined when none do. */
function narratedInvocation(text: string): RegExp | undefined {
  return NARRATED_INVOCATION_PATTERNS.find((pattern) => pattern.test(text));
}

/**
 * Inspect one assistant turn for fabricated tool-cli usage.
 *
 * Returns every finding rather than the first, so a regression test can assert
 * on the specific failure mode instead of just "something was wrong".
 */
export function detectToolCliTripwires(
  turn: AssistantTurn,
  options: TripwireOptions = {},
): TripwireFinding[] {
  const bashToolNames = options.bashToolNames ?? DEFAULT_BASH_TOOL_NAMES;

  // A genuine invocation clears both tripwires: the agent really did run it, so
  // whatever it wrote about the command is grounded in a real result.
  if (hasRealToolCliCall(turn, bashToolNames)) {
    return [];
  }

  const findings: TripwireFinding[] = [];

  if (PSEUDO_CALL_PATTERN.test(turn.text)) {
    findings.push({
      code: "tool_cli_pseudo_call",
      evidence: excerpt(turn.text, PSEUDO_CALL_PATTERN),
      message:
        "Assistant text contains tool-cli markup but no bash tool call ran tool-cli. tool-cli is invoked by calling the bash tool with a `tool-cli ...` command, never by emitting XML or text that imitates a call.",
    });
  }

  const narrated = narratedInvocation(turn.text);
  if (narrated) {
    findings.push({
      code: "tool_cli_narrated_without_bash",
      evidence: excerpt(turn.text, narrated),
      message:
        "Assistant text narrates a tool-cli invocation but no bash tool call ran tool-cli, so any output shown was fabricated rather than observed.",
    });
  }

  return findings;
}
