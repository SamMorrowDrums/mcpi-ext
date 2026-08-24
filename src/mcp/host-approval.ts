import type { ExtensionContext } from "@sammorrowdrums/mcpi";
import type { McpApprovalPrompt, McpApprovalRequest } from "./policy.js";

type ApprovalContext = Pick<ExtensionContext, "hasUI" | "ui">;

/**
 * Bridges policy approval requests to mcpi's explicit user-facing confirmation.
 *
 * Mirrors {@link McpiHostElicitation}: without an interactive UI the request is
 * reported as undecided rather than approved, so nothing is ever silently
 * enabled.
 */
export class McpiHostApproval implements McpApprovalPrompt {
  private context: ApprovalContext | undefined;

  setContext(context: ApprovalContext | undefined): void {
    this.context = context;
  }

  async confirm(request: McpApprovalRequest): Promise<boolean | undefined> {
    const context = this.context;
    if (!context?.hasUI) return undefined;

    return context.ui.confirm(
      request.title,
      request.message,
      request.signal ? { signal: request.signal } : undefined,
    );
  }
}
