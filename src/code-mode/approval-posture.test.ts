import { describe, it, expect } from "vitest";
import type { McpTool } from "../mcp/index.js";
import { isReadOnlyToolCall } from "../mcp/policy.js";
import {
  APPROVAL_POSTURE_SCHEMA_VERSION,
  APPROVAL_REASON_ORDER,
  approvalPosture,
  serializeApprovalPosture,
  toCodeModeTool,
  type CodeModeEffectClass,
} from "./eligibility.js";

/**
 * The catalog fingerprints a tool's definition so a cached snapshot is
 * invalidated when the definition changes. Approval posture is part of that
 * definition, and it is the part with a security consequence: if a snapshot
 * survives a tool becoming destructive, the sandbox goes on treating it the
 * way it was first classified.
 *
 * `runsUnattended` on its own cannot carry that. It is a boolean, so an
 * ordinary write and a destructive one are the same byte, and a digest over it
 * is blind to exactly the transition that matters most. These tests pin the
 * classification that is injective on posture, and pin its serialization,
 * because a fingerprint is only as stable as the string it is taken over.
 */

function makeTool(annotations: McpTool["annotations"], name = "t"): McpTool {
  return {
    name,
    description: "d",
    inputSchema: { type: "object", properties: {} },
    serverName: "s",
    annotations,
  };
}

const POSTURES: {
  label: string;
  annotations: McpTool["annotations"];
  effect: CodeModeEffectClass;
}[] = [
  { label: "annotated read-only", annotations: { readOnlyHint: true }, effect: "read_only" },
  { label: "no annotations", annotations: undefined, effect: "write" },
  { label: "explicitly not read-only", annotations: { readOnlyHint: false }, effect: "write" },
  {
    label: "declared destructive",
    annotations: { readOnlyHint: false, destructiveHint: true },
    effect: "destructive",
  },
  {
    label: "read-only and destructive at once",
    annotations: { readOnlyHint: true, destructiveHint: true },
    effect: "contradictory_annotations",
  },
];

describe("approval posture as digest input", () => {
  describe("classification", () => {
    for (const { label, annotations, effect } of POSTURES) {
      it(`classifies a tool that is ${label} as ${effect}`, () => {
        expect(approvalPosture(makeTool(annotations)).effect).toBe(effect);
      });
    }

    it("agrees with the policy about what runs unattended", () => {
      // The class is a description of the posture, not a second opinion about
      // it. Only `read_only` may run without asking.
      for (const { annotations, effect } of POSTURES) {
        const tool = makeTool(annotations);
        const posture = approvalPosture(tool);
        expect(posture.runsUnattended).toBe(isReadOnlyToolCall(tool));
        expect(posture.runsUnattended).toBe(effect === "read_only");
      }
    });

    it("keeps a contradictory annotation distinct from a plain destructive one", () => {
      // If these collapsed, a tool losing `readOnlyHint` while already
      // destructive would produce no digest change — and a tool that was once
      // advertised as safe becoming unambiguously destructive is precisely the
      // transition a posture fingerprint exists to catch.
      const contradictory = serializeApprovalPosture(
        approvalPosture(makeTool({ readOnlyHint: true, destructiveHint: true })),
      );
      const destructive = serializeApprovalPosture(
        approvalPosture(makeTool({ readOnlyHint: false, destructiveHint: true })),
      );
      expect(contradictory).not.toBe(destructive);
    });
  });

  describe("normalized reasons", () => {
    it("emits reasons in the canonical order, never derivation order", () => {
      const posture = approvalPosture(makeTool({ readOnlyHint: false, destructiveHint: true }));
      expect(posture.reasons).toEqual(["not_annotated_read_only", "destructive_hint"]);
      const indices = posture.reasons.map((r) => APPROVAL_REASON_ORDER.indexOf(r));
      expect(indices).toEqual([...indices].sort((a, b) => a - b));
    });

    it("never repeats a reason", () => {
      for (const { annotations } of POSTURES) {
        const reasons = approvalPosture(makeTool(annotations)).reasons;
        expect(new Set(reasons).size).toBe(reasons.length);
      }
    });

    it("says nothing about a tool that runs unattended", () => {
      expect(approvalPosture(makeTool({ readOnlyHint: true })).reasons).toEqual([]);
    });

    it("serializes a reason list order-insensitively", () => {
      // A caller handing back the same set in a different order is the same
      // posture and must produce the same bytes.
      const canonical = serializeApprovalPosture({
        effect: "destructive",
        runsUnattended: false,
        reasons: ["not_annotated_read_only", "destructive_hint"],
      });
      const reversed = serializeApprovalPosture({
        effect: "destructive",
        runsUnattended: false,
        reasons: ["destructive_hint", "not_annotated_read_only"],
      });
      expect(reversed).toBe(canonical);
    });
  });

  describe("serialization", () => {
    it("is stable across calls", () => {
      const tool = makeTool({ readOnlyHint: false, destructiveHint: true });
      expect(serializeApprovalPosture(approvalPosture(tool))).toBe(
        serializeApprovalPosture(approvalPosture(tool)),
      );
    });

    it("is injective: every distinct posture serializes differently", () => {
      // The property the digest depends on. If two postures collide here, a
      // snapshot taken under one silently satisfies the other.
      const serialized = POSTURES.map(({ annotations }) =>
        serializeApprovalPosture(approvalPosture(makeTool(annotations))),
      );
      const distinctEffects = new Set(POSTURES.map((p) => p.effect)).size;
      expect(new Set(serialized).size).toBe(distinctEffects);
    });

    it("carries the vocabulary version, so changing the vocabulary re-snapshots", () => {
      const s = serializeApprovalPosture(approvalPosture(makeTool({ readOnlyHint: true })));
      expect(s.startsWith(`v${String(APPROVAL_POSTURE_SCHEMA_VERSION)}:`)).toBe(true);
    });

    it("draws every component from a closed vocabulary", () => {
      // No server-controlled string reaches the digest, so no name can be
      // chosen to collide with a delimiter or impersonate another posture.
      const hostile = makeTool({ readOnlyHint: true }, "v1:read_only:unattended:");
      const s = serializeApprovalPosture(approvalPosture(hostile));
      expect(s).not.toContain(hostile.name.slice(0, 3) + ":read_only:unattended::");
      expect(s).toBe("v1:read_only:unattended:");
    });

    it("does not depend on anything but posture", () => {
      // Renaming a tool, changing its description, or declaring an output
      // schema is a definition change the digest sees elsewhere. It must not
      // move the approval component, or every unrelated edit would look like
      // an approval change and the signal would be worthless.
      const a = approvalPosture(makeTool({ readOnlyHint: false }, "alpha"));
      const b = approvalPosture({
        ...makeTool({ readOnlyHint: false }, "beta"),
        description: "totally different",
        outputSchema: { type: "object", properties: { x: { type: "string" } } },
      });
      expect(serializeApprovalPosture(b)).toBe(serializeApprovalPosture(a));
    });
  });

  describe("the catalog entry carries the same posture", () => {
    it("exposes effect and reasons alongside the boolean", () => {
      for (const { annotations, effect } of POSTURES) {
        const entry = toCodeModeTool(makeTool(annotations));
        const posture = approvalPosture(makeTool(annotations));
        expect(entry.effect).toBe(effect);
        expect(entry.runsUnattended).toBe(posture.runsUnattended);
        expect(entry.approvalReasons).toEqual(posture.reasons);
      }
    });

    it("round-trips through approvalPosture unchanged", () => {
      // The catalog entry is an acceptable digest input on its own, so reading
      // the posture back out of it must not reclassify anything.
      for (const { annotations } of POSTURES) {
        const entry = toCodeModeTool(makeTool(annotations));
        expect(approvalPosture(entry)).toEqual({
          effect: entry.effect,
          runsUnattended: entry.runsUnattended,
          reasons: entry.approvalReasons,
        });
      }
    });
  });
});
