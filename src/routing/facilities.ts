import type { BridgeInfo } from "@sammorrowdrums/tool-cli/client";

/**
 * The model-facing execution facilities mcpi-ext puts in front of an agent.
 *
 * An agent has to decide, per task, which surface actually does the work. This
 * module is the single source of truth for how those surfaces are described:
 * `buildExecutionFacilities` turns observed session state into a stable ordered
 * list of descriptors, and every consumer — the prompt fallback and the future
 * host registration seam — renders from that same list.
 *
 * Two rules govern everything here:
 *
 * 1. **Task shape, not precedence.** Each facility is described by the kind of
 *    work it suits. No facility outranks another and none is a default. The
 *    list is ordered alphabetically by id purely so the emitted bytes are
 *    stable across turns; the order carries no ranking.
 * 2. **Availability is always stated.** A facility is never silently dropped.
 *    An unavailable facility is still listed together with the reason, so the
 *    agent neither attempts it nor invents output it never produced.
 */

/** Stable machine identifiers for the four facilities. */
export type FacilityId = "bash" | "code_mode" | "skills" | "tool_cli";

/**
 * Facility order. Alphabetical by id so the rendered section is byte-stable.
 * This is deliberately not a preference order.
 */
export const FACILITY_ORDER: readonly FacilityId[] = ["bash", "code_mode", "skills", "tool_cli"];

/**
 * Three states, because "we could not tell" is a real answer and is not the
 * same as "it is not there". Claiming either would be untruthful.
 */
export type AvailabilityState = "available" | "unavailable" | "unknown";

export interface FacilityAvailability {
  state: AvailabilityState;
  /** Always populated. The reason for the state, never an empty string. */
  detail: string;
}

export interface ExecutionFacility {
  id: FacilityId;
  /** Heading shown to the model. */
  title: string;
  /** Intent-first sentence. Always begins with "Use when". */
  useWhen: string;
  /** What the facility actually does. */
  provides: string[];
  /** What it deliberately cannot do, so the agent does not mis-route to it. */
  doesNotProvide: string[];
  availability: FacilityAvailability;
}

/** Skills discovered this session, plus the status of the draft extension. */
export interface SkillsState {
  count: number;
  /** Whether the DRAFT, unratified SEP-2640 skills extension is enabled. */
  draftExtensionEnabled: boolean;
}

/**
 * tool-cli is only advertised after its local bridge completes an authenticated
 * compatible handshake. Failures remain explicit so the prompt has a next step.
 */
export type ToolCliState =
  | { kind: "verified"; port: number; bridgeInfo: BridgeInfo }
  | { kind: "not_started"; reason: string }
  | { kind: "failed"; reason: string }
  | { kind: "incompatible"; reason: string }
  | { kind: "no_bash"; reason: string };

/**
 * What a shell can actually reach, when someone has told us.
 *
 * `unknown` is the default and is load-bearing. A host may run the shell tool
 * inside a container with no route off the machine, and the prompt has no way
 * to detect that. Stating "network access" anyway is not a harmless
 * simplification: an agent that believes it can reach the network will spend
 * the turn on `gh` and `curl`, fail opaquely, and never try the on-ramp that
 * would have worked. So an unprofiled capability is described as unverified,
 * never as present.
 */
export type CapabilityClaim = "available" | "restricted" | "unavailable" | "unknown";

/**
 * A host-supplied description of the shell's reach.
 *
 * This is a seam, not a sandbox. mcpi-ext does not restrict anything here and
 * cannot verify these claims; it only refuses to invent capabilities it was
 * not told about. A host that knows its execution profile fills this in, and
 * the routing section becomes truthful for that profile.
 */
export interface BashCapabilityProfile {
  /** Profile name for the operator's benefit, e.g. "container-no-egress". */
  name?: string;
  filesystem?: CapabilityClaim;
  network?: CapabilityClaim;
  process?: CapabilityClaim;
  /** Host-authored detail appended verbatim, e.g. an allowed-egress list. */
  note?: string;
}

/** Whether the host currently exposes a shell tool, when that is discoverable at all. */
export type BashState =
  | { kind: "registered"; toolName: string; profile?: BashCapabilityProfile }
  | { kind: "absent" }
  | { kind: "undiscoverable"; reason: string };

export interface ExecutionRoutingState {
  skills: SkillsState;
  codeMode: CodeModeState;
  toolCli: ToolCliState;
  bash: BashState;
}

/**
 * Code mode needs the optional `isolated-vm` native addon. When that addon is
 * absent the facility is genuinely unavailable, and `reason` carries the
 * specific cause so the prompt can say *why* rather than just that it failed.
 */
export interface CodeModeState {
  active: boolean;
  /** Why code mode is inactive. Ignored when `active` is true. */
  reason?: string;
}

function skillsAvailability(skills: SkillsState): FacilityAvailability {
  const draft = skills.draftExtensionEnabled
    ? "Draft SEP-2640 skills extension: enabled (unratified draft)."
    : "Draft SEP-2640 skills extension: disabled.";

  if (skills.count === 0) {
    return {
      state: "unavailable",
      detail: `No MCP skills were discovered this session. ${draft} There is nothing for load_skill to load, so route the task to another facility.`,
    };
  }

  return {
    state: "available",
    detail: `${skills.count} MCP skill(s) discovered and loadable by name. ${draft}`,
  };
}

function codeModeAvailability(codeMode: CodeModeState): FacilityAvailability {
  if (!codeMode.active) {
    const cause = codeMode.reason?.trim();
    return {
      state: "unavailable",
      detail: cause
        ? `Code mode is unavailable because ${cause}. code_execute and code_search cannot run; sandboxed execution is never downgraded to an in-process fallback. Route exact computation to bash or tool-cli instead.`
        : "Code mode did not initialise this session, so code_execute and code_search cannot run.",
    };
  }

  return {
    state: "available",
    detail:
      "Available with zero MCP servers connected — pure computation needs no server, and code_execute is registered whenever mcpi-ext loads.",
  };
}

function toolCliAvailability(toolCli: ToolCliState, bash: BashState): FacilityAvailability {
  if (toolCli.kind === "incompatible") {
    return {
      state: "unavailable",
      detail: `The authenticated tool-cli bridge handshake found an incompatible bridge/client contract: ${toolCli.reason}. TOOL_CLI_PORT and TOOL_CLI_TOKEN were not exposed. Install matching tool-cli and mcpi-ext major versions before retrying.`,
    };
  }

  if (toolCli.kind === "failed") {
    return {
      state: "unavailable",
      detail: `The local tool-cli bridge failed startup or its authenticated handshake: ${toolCli.reason}. MCP tools cannot be reached from the shell this session — use another available facility and report this failure rather than retrying tool-cli blindly.`,
    };
  }

  if (toolCli.kind === "no_bash") {
    return {
      state: "unavailable",
      detail: `The tool-cli bridge was not started because bash availability is required and was not confirmed: ${toolCli.reason}. No bridge credentials were exposed.`,
    };
  }

  if (toolCli.kind === "not_started") {
    return {
      state: "unavailable",
      detail: `The local tool-cli RPC server was not started: ${toolCli.reason}.`,
    };
  }

  const verified =
    `The local tool-cli bridge started on port ${toolCli.port}, completed an authenticated ` +
    `${toolCli.bridgeInfo.bridgeProtocol.name} v${toolCli.bridgeInfo.bridgeProtocol.version} handshake, ` +
    `and reported ${toolCli.bridgeInfo.serverImplementation.name}@${toolCli.bridgeInfo.serverImplementation.version}.`;

  // tool-cli is reached through the shell, so a missing shell tool makes a
  // healthy RPC server unusable. Saying "available" here would be a lie.
  if (bash.kind === "absent") {
    return {
      state: "unavailable",
      detail: `${verified} However, no host bash tool is active now, so its credentials are not usable through the required invocation path.`,
    };
  }

  if (bash.kind === "undiscoverable") {
    return {
      state: "unavailable",
      detail: `${verified} However, current bash availability is unconfirmed (${bash.reason}), so tool-cli is not advertised as invocable.`,
    };
  }

  return {
    state: "available",
    detail: `${verified} TOOL_CLI_PORT and TOOL_CLI_TOKEN are set for commands run with the "${bash.toolName}" tool.`,
  };
}

const CAPABILITY_WORDING: Record<CapabilityClaim, string> = {
  available: "available",
  restricted: "restricted — assume only what the host note allows",
  unavailable: "not available from this shell",
  unknown: "not profiled; treat as unverified rather than assuming either way",
};

/**
 * Describe the shell's reach without overclaiming.
 *
 * Deterministic and total: every capability is named in a fixed order with a
 * non-empty wording, so the rendered section stays byte-stable and no
 * capability is silently omitted.
 */
function bashCapabilities(profile: BashCapabilityProfile | undefined): string {
  const claims: [string, CapabilityClaim][] = [
    ["filesystem", profile?.filesystem ?? "unknown"],
    ["network", profile?.network ?? "unknown"],
    ["process", profile?.process ?? "unknown"],
  ];
  const described = claims
    .map(([name, claim]) => `${name} ${CAPABILITY_WORDING[claim]}`)
    .join("; ");
  const named = profile?.name ? ` Execution profile: ${profile.name}.` : "";
  const note = profile?.note ? ` ${profile.note}` : "";
  return `The host bash tool, which runs real shell commands. Reach: ${described}.${named}${note}`;
}

/**
 * Warn against the specific mis-route a restricted network produces.
 *
 * An agent that cannot reach the network usually discovers this by burning a
 * turn on `gh` or `curl`. Naming the on-ramp here turns that dead end into a
 * redirect, and it is stated only when the network is actually in doubt.
 */
function bashNetworkCaveat(profile: BashCapabilityProfile | undefined): string[] {
  const network = profile?.network ?? "unknown";
  if (network === "available") return [];
  return [
    "Guaranteed reach to the public network. Do not assume `gh`, `curl`, or a package manager can leave this machine; when data is available through an MCP server, tool-cli reaches it over the authorised local bridge and does not depend on egress.",
  ];
}

function bashAvailability(bash: BashState): FacilityAvailability {
  switch (bash.kind) {
    case "registered":
      return {
        state: "available",
        detail: `The host "${bash.toolName}" tool is active this session.`,
      };
    case "absent":
      return {
        state: "unavailable",
        detail:
          "No host shell tool is active this session, so shell commands, external programs, and tool-cli cannot run.",
      };
    case "undiscoverable":
      return {
        state: "unknown",
        detail: `The host tool registry could not be read (${bash.reason}), so shell availability is unconfirmed. Try the command you need and treat a failure as absence rather than assuming either way.`,
      };
  }
}

/**
 * Build the ordered facility descriptors for the current session.
 *
 * Pure and deterministic: equal input always yields an equal list in
 * `FACILITY_ORDER`, so the rendered prompt section is byte-stable.
 */
export function buildExecutionFacilities(state: ExecutionRoutingState): ExecutionFacility[] {
  return [
    {
      id: "bash",
      title: "bash and external programs",
      useWhen:
        "Use when the task touches the real machine: reading or writing files, running git, package managers, compilers, formatters or test runners, moving data between programs, or producing an artifact that has to exist on disk afterwards.",
      provides: [
        bashCapabilities(state.bash.kind === "registered" ? state.bash.profile : undefined),
        "Every external program installed on the host, composed with pipes, redirection, loops, globs, and exit codes.",
        "The substrate the other facilities lack: this is the only facility that can create, modify, or inspect files and artifacts.",
      ],
      doesNotProvide: [
        "MCP tool access on its own — reaching an MCP tool from the shell is the tool-cli facility, itself run as a bash command.",
        "A sandbox. Commands run with the host's real permissions and their effects persist.",
        ...bashNetworkCaveat(state.bash.kind === "registered" ? state.bash.profile : undefined),
      ],
      availability: bashAvailability(state.bash),
    },
    {
      id: "code_mode",
      title: "Code mode (code_execute, code_search)",
      useWhen:
        "Use when the task needs exact computation or control flow: arithmetic, date maths, parsing, filtering, aggregation, pagination loops, or joining results — anywhere an approximated answer would simply be wrong.",
      provides: [
        "code_execute, which runs vanilla JavaScript in a sandboxed V8 isolate and returns the value you return.",
        "code_search, which queries the MCP tool catalogue so you can find dispatchable tools before writing code.",
        "MCP tools dispatched from inside the sandbox through the codemode namespace, so one execution can loop over many calls. Read-only tools run unattended; a write or destructive tool pauses mid-script for your approval and continues with the value it returns.",
      ],
      doesNotProvide: [
        "Filesystem access. There is no fs, no file read or write, and no path the isolate can reach.",
        "Network access. There is no fetch, no sockets, and no outbound request of any kind.",
        "Process access. There is no process, no require, no import, and no child process.",
      ],
      availability: codeModeAvailability(state.codeMode),
    },
    {
      id: "skills",
      title: "Skills (load_skill)",
      useWhen:
        "Use when the task is a domain workflow an MCP server has already documented — a named procedure with its own sequencing, conventions, and curated tool set, such as a triage runbook or a release checklist. Reach for a skill because the procedure is what you need, not because a tool it names happens to exist.",
      provides: [
        "Workflow guidance authored by the server: the skill body, loaded on demand by name with load_skill.",
        "The full schemas of the tool definitions that skill references, revealed in the transcript when it loads.",
      ],
      doesNotProvide: [
        "Computation, filesystem access, or shell access.",
        "Any change to what may execute. Loading a skill reveals schemas; it grants nothing, and the tools it omits stay just as reachable as they were.",
      ],
      availability: skillsAvailability(state.skills),
    },
    {
      id: "tool_cli",
      title: "tool-cli (MCP-to-shell on-ramp)",
      useWhen:
        "Use when you need to reach a specific MCP tool directly and no documented skill covers the task, or when you want to discover which servers and tools exist before committing to an approach.",
      provides: [
        "An authenticated command-line on-ramp to the same MCP tools the host already authorises, invoked through the host bash tool as `tool-cli ...`.",
        "Progressive discovery: servers, then a server's tools, then one tool's schema, so you read only what you need.",
        "Policy-authorized MCP resource listing, templates, and reads, including binary output written with `--out`.",
        "Plain text and JSON on stdout, so results compose with jq, grep, pipes, and loops inside the same bash command.",
      ],
      doesNotProvide: [
        "A tool of its own. tool-cli is a program you run with the bash tool, never something you call directly.",
        "Any authority the host has not already granted — every call is re-authorised before it reaches a server.",
        "Access to `skill://` resources, which remain isolated behind skill discovery and load_skill.",
      ],
      availability: toolCliAvailability(state.toolCli, state.bash),
    },
  ];
}
