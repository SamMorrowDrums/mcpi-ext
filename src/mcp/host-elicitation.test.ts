import type { ExtensionContext } from "@sammorrowdrums/mcpi";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpiHostElicitation } from "./host-elicitation.js";

describe("McpiHostElicitation", () => {
  let handler: McpiHostElicitation;
  let select: ReturnType<typeof vi.fn>;
  let editor: ReturnType<typeof vi.fn>;
  let notify: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    handler = new McpiHostElicitation();
    select = vi.fn();
    editor = vi.fn();
    notify = vi.fn();
    handler.setContext({
      hasUI: true,
      ui: { select, editor, notify } as unknown as ExtensionContext["ui"],
    });
  });

  it("fails actionably instead of approving when no interactive UI exists", async () => {
    handler.setContext({ hasUI: false, ui: {} as ExtensionContext["ui"] });

    await expect(handler.elicit(formRequest)).rejects.toThrow("mcpi has no interactive UI");
  });

  it("returns an explicit decline without opening the input editor", async () => {
    select.mockResolvedValueOnce("Decline");

    await expect(handler.elicit(formRequest)).resolves.toEqual({ action: "decline" });
    expect(editor).not.toHaveBeenCalled();
  });

  it("treats a dismissed approval selector as cancellation", async () => {
    select.mockResolvedValueOnce(undefined);

    await expect(handler.elicit(formRequest)).resolves.toEqual({ action: "cancel" });
    expect(editor).not.toHaveBeenCalled();
  });

  it("accepts only explicit JSON input supplied through the editor", async () => {
    select.mockResolvedValueOnce("Provide input");
    editor.mockResolvedValueOnce('{"approved":true,"reason":"reviewed"}');

    await expect(handler.elicit(formRequest)).resolves.toEqual({
      action: "accept",
      content: { approved: true, reason: "reviewed" },
    });
    expect(editor).toHaveBeenCalledWith(
      "MCP input required (JSON)",
      JSON.stringify({ approved: false, reason: "" }, null, 2),
    );
  });

  it("rejects URL elicitation because the client does not advertise it", async () => {
    await expect(
      handler.elicit({
        mode: "url",
        message: "Authenticate",
        elicitationId: "auth-1",
        url: "https://example.com/auth",
      }),
    ).rejects.toThrow("MCP URL elicitation is unsupported");
  });
});

const formRequest = {
  mode: "form" as const,
  message: "Approve the read-only lookup?",
  requestedSchema: {
    type: "object" as const,
    properties: {
      approved: { type: "boolean" as const },
      reason: { type: "string" as const },
    },
    required: ["approved"],
  },
};
