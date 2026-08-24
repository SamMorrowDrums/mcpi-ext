import { describe, it, expect } from "vitest";
import { buildExecutionFacilities, FACILITY_ORDER, type ExecutionFacility } from "./facilities.js";
import {
  publishExecutionFacilities,
  supportsExecutionFacilityRegistration,
  type ExecutionFacilityRegistrar,
} from "./seam.js";

function facilities(): ExecutionFacility[] {
  return buildExecutionFacilities({
    skills: { count: 2, draftExtensionEnabled: false },
    codeMode: { active: true },
    toolCli: { kind: "started", port: 4242 },
    bash: { kind: "registered", toolName: "bash" },
  });
}

describe("execution facility seam", () => {
  // Named no-op: these hosts exist only to exercise detection, and an inline
  // `() => {}` trips no-empty-function.
  function ignore(): void {
    return;
  }

  describe("feature detection", () => {
    it("rejects a host without the API", () => {
      // This is every shipped mcpi core today.
      expect(supportsExecutionFacilityRegistration({ registerTool: ignore })).toBe(false);
    });

    it("rejects a host carrying a non-function property of the same name", () => {
      const host = { registerExecutionFacility: "soon" };
      expect(supportsExecutionFacilityRegistration(host)).toBe(false);
    });

    it("accepts a host implementing the API", () => {
      const host: ExecutionFacilityRegistrar = { registerExecutionFacility: ignore };
      expect(supportsExecutionFacilityRegistration(host)).toBe(true);
    });
  });

  describe("publishing", () => {
    it("returns false and registers nothing when the API is absent", () => {
      expect(publishExecutionFacilities({}, facilities())).toBe(false);
    });

    it("hands every facility to the host, in order, when the API exists", () => {
      const received: ExecutionFacility[] = [];
      const host: ExecutionFacilityRegistrar = {
        registerExecutionFacility(facility) {
          received.push(facility);
        },
      };

      expect(publishExecutionFacilities(host, facilities())).toBe(true);
      expect(received.map((f) => f.id)).toEqual([...FACILITY_ORDER]);
      for (const facility of received) {
        expect(facility.useWhen.startsWith("Use when")).toBe(true);
        expect(facility.availability.detail.length).toBeGreaterThan(0);
      }
    });

    it("keeps the host path and the fallback path mutually exclusive", () => {
      // before_agent_start emits its own section only when publishing returns
      // false, so a host that gains the API can never see the section twice.
      const withoutApi = publishExecutionFacilities({}, facilities());
      const withApi = publishExecutionFacilities(
        { registerExecutionFacility: ignore } satisfies ExecutionFacilityRegistrar,
        facilities(),
      );

      expect(withoutApi).toBe(false);
      expect(withApi).toBe(true);
      expect(withoutApi).not.toBe(withApi);
    });
  });
});
