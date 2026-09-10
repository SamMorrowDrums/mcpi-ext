import { describe, it, expect } from "vitest";
import {
  buildExecutionFacilities,
  type BashCapabilityProfile,
  type ExecutionRoutingState,
} from "./facilities.js";
import { formatExecutionRouting } from "./format.js";

/**
 * These tests exist because of a real failure, not a hypothetical one.
 *
 * A research host replaced the shell tool with a container-exec bash that had
 * no route off the machine. The routing section told the agent bash had
 * "filesystem, network, and process access", so the agent spent its turn on
 * `gh` and `curl`, failed opaquely, and never tried the on-ramp that would
 * have worked. The prompt cannot detect the container. What it can do is stop
 * asserting a capability nobody told it about.
 */

function stateWithProfile(profile?: BashCapabilityProfile): ExecutionRoutingState {
  return {
    skills: { count: 0, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: { kind: "not_started", reason: "no MCP servers are configured" },
    bash: { kind: "registered", toolName: "bash", profile },
  };
}

function bashFacility(state: ExecutionRoutingState) {
  const facility = buildExecutionFacilities(state).find((f) => f.id === "bash");
  if (!facility) throw new Error("bash facility missing from the descriptor list");
  return facility;
}

const NETWORK_CAVEAT = "Do not assume `gh`, `curl`, or a package manager can leave this machine";

describe("bash capability profile", () => {
  describe("the unprofiled default", () => {
    it("does not claim network access when nobody said there was any", () => {
      const provides = bashFacility(stateWithProfile()).provides.join(" ");
      expect(provides).not.toContain("filesystem, network, and process access");
      expect(provides).toContain("network not profiled");
    });

    it("describes every capability as unverified rather than absent", () => {
      // Overclaiming sends the agent down a dead end; underclaiming stops it
      // using a shell it actually has. Unverified is the only honest default.
      const provides = bashFacility(stateWithProfile()).provides.join(" ");
      for (const capability of ["filesystem", "network", "process"]) {
        expect(provides).toContain(`${capability} not profiled`);
      }
      expect(provides).toContain("treat as unverified rather than assuming either way");
    });

    it("names the on-ramp instead of leaving the agent at the dead end", () => {
      const facility = bashFacility(stateWithProfile());
      const caveat = facility.doesNotProvide.join(" ");
      expect(caveat).toContain(NETWORK_CAVEAT);
      expect(caveat).toContain("tool-cli reaches it over the authorised local bridge");
    });
  });

  describe("a host that states its profile", () => {
    it("says so plainly when the network really is available", () => {
      const facility = bashFacility(stateWithProfile({ network: "available" }));
      expect(facility.provides.join(" ")).toContain("network available");
      // The redirect is a correction for a wrong belief. With egress confirmed
      // there is no wrong belief to correct, and repeating it would itself
      // mislead.
      expect(facility.doesNotProvide.join(" ")).not.toContain(NETWORK_CAVEAT);
    });

    it("keeps the redirect for a restricted network, not only an absent one", () => {
      for (const network of ["restricted", "unavailable", "unknown"] as const) {
        const facility = bashFacility(stateWithProfile({ network }));
        expect(facility.doesNotProvide.join(" ")).toContain(NETWORK_CAVEAT);
      }
    });

    it("reproduces the container-exec profile that caused the failure", () => {
      const facility = bashFacility(
        stateWithProfile({
          name: "container-exec-no-egress",
          filesystem: "available",
          network: "unavailable",
          process: "available",
        }),
      );
      const provides = facility.provides.join(" ");
      expect(provides).toContain("filesystem available");
      expect(provides).toContain("network not available from this shell");
      expect(provides).toContain("Execution profile: container-exec-no-egress.");
      expect(facility.doesNotProvide.join(" ")).toContain(NETWORK_CAVEAT);
    });

    it("passes a host note through verbatim", () => {
      const note = "Egress is allowed to registry.example.internal only.";
      const facility = bashFacility(stateWithProfile({ network: "restricted", note }));
      expect(facility.provides.join(" ")).toContain(note);
    });

    it("still describes bash as the artifact substrate under any profile", () => {
      // A restricted network does not stop the shell being the only facility
      // that can put a file on disk. Narrowing reach must not narrow purpose.
      const facility = bashFacility(stateWithProfile({ network: "unavailable" }));
      expect(facility.provides.join(" ")).toContain(
        "the only facility that can create, modify, or inspect files and artifacts",
      );
    });
  });

  describe("the profile is a seam, not a sandbox", () => {
    it("changes only wording, never availability", () => {
      const unprofiled = bashFacility(stateWithProfile());
      const locked = bashFacility(
        stateWithProfile({ filesystem: "unavailable", network: "unavailable" }),
      );
      // mcpi-ext does not enforce these claims and must not pretend to. A
      // profile that describes a locked-down shell still reports the shell as
      // active, because it is.
      expect(locked.availability.state).toBe("available");
      expect(locked.availability).toEqual(unprofiled.availability);
    });

    it("is ignored entirely when no shell is registered", () => {
      const absent: ExecutionRoutingState = { ...stateWithProfile(), bash: { kind: "absent" } };
      const facility = bashFacility(absent);
      expect(facility.availability.state).toBe("unavailable");
      expect(facility.provides.join(" ")).toContain("network not profiled");
    });
  });

  describe("determinism", () => {
    it("renders byte-identically for an equal profile", () => {
      const profile: BashCapabilityProfile = {
        name: "p",
        filesystem: "available",
        network: "restricted",
        process: "unknown",
        note: "n",
      };
      expect(formatExecutionRouting(stateWithProfile({ ...profile }))).toBe(
        formatExecutionRouting(stateWithProfile({ ...profile })),
      );
    });

    it("orders capabilities the same way regardless of key order", () => {
      const a = formatExecutionRouting(
        stateWithProfile({ filesystem: "available", network: "unavailable", process: "available" }),
      );
      const b = formatExecutionRouting(
        stateWithProfile({ process: "available", network: "unavailable", filesystem: "available" }),
      );
      expect(a).toBe(b);
    });
  });
});
