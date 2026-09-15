import type { ExtensionContext } from "@sammorrowdrums/mcpi";
import type { McpApprovalPrompt, McpApprovalRequest } from "./policy.js";

type ApprovalContext = Pick<ExtensionContext, "hasUI" | "ui">;

interface QueuedApproval {
  readonly request: McpApprovalRequest;
  readonly context: ApprovalContext;
  readonly contextVersion: number;
  readonly resolve: (value: boolean | undefined) => void;
  state: "queued" | "active" | "settled";
  activeController?: AbortController;
  abortListener?: () => void;
}

/**
 * Bridges policy approval requests to mcpi's explicit user-facing confirmation.
 *
 * Mirrors {@link McpiHostElicitation}: without an interactive UI the request is
 * reported as undecided rather than approved, so nothing is ever silently
 * enabled. Host selectors are single-owner UI, so confirmations are serialized
 * here in strict FIFO order rather than allowing one prompt to replace another.
 */
export class McpiHostApproval implements McpApprovalPrompt {
  private context: ApprovalContext | undefined;
  private contextVersion = 0;
  private readonly queue: QueuedApproval[] = [];
  private active: QueuedApproval | undefined;

  setContext(context: ApprovalContext | undefined): void {
    if (context === this.context) return;

    this.context = context;
    this.contextVersion += 1;

    // A request belongs to the interactive session in which it was made.
    // Session shutdown/replacement fails every old request closed rather than
    // replaying it into a later context where it was never authorized.
    for (const entry of this.queue.splice(0)) {
      this.settle(entry, undefined);
    }
    if (this.active) {
      this.active.activeController?.abort();
      this.settle(this.active, undefined);
    }
  }

  confirm(request: McpApprovalRequest): Promise<boolean | undefined> {
    if (request.signal?.aborted) return Promise.resolve(undefined);

    const context = this.context;
    if (!context?.hasUI) return Promise.resolve(undefined);

    return new Promise((resolve) => {
      const entry: QueuedApproval = {
        request,
        context,
        contextVersion: this.contextVersion,
        resolve,
        state: "queued",
      };

      if (request.signal) {
        entry.abortListener = () => {
          if (entry.state === "active") {
            entry.activeController?.abort();
          } else {
            this.settle(entry, undefined);
          }
        };
        request.signal.addEventListener("abort", entry.abortListener, { once: true });
        if (request.signal.aborted) {
          this.settle(entry, undefined);
          return;
        }
      }

      this.queue.push(entry);
      this.drain();
    });
  }

  private drain(): void {
    if (this.active) return;

    let entry = this.queue.shift();
    while (entry) {
      if (entry.state === "settled") {
        entry = this.queue.shift();
        continue;
      }

      const context = this.context;
      if (
        !context?.hasUI ||
        context !== entry.context ||
        entry.contextVersion !== this.contextVersion ||
        entry.request.signal?.aborted
      ) {
        this.settle(entry, undefined);
        entry = this.queue.shift();
        continue;
      }

      entry.state = "active";
      entry.activeController = new AbortController();
      this.active = entry;
      void this.runActive(entry, context);
      return;
    }
  }

  private async runActive(entry: QueuedApproval, context: ApprovalContext): Promise<void> {
    let result: boolean | undefined;
    try {
      const controller = entry.activeController;
      if (!controller) return;

      const decision = await context.ui.confirm(entry.request.title, entry.request.message, {
        signal: controller.signal,
      });
      if (
        !controller.signal.aborted &&
        this.context === entry.context &&
        entry.contextVersion === this.contextVersion
      ) {
        result = decision;
      }
    } catch {
      // A failed or cancelled host prompt is never approval.
    } finally {
      this.settle(entry, result);
      if (this.active === entry) this.active = undefined;
      entry.activeController = undefined;
      this.drain();
    }
  }

  private settle(entry: QueuedApproval, result: boolean | undefined): void {
    if (entry.state === "settled") return;

    entry.state = "settled";
    if (entry.abortListener && entry.request.signal) {
      entry.request.signal.removeEventListener("abort", entry.abortListener);
      entry.abortListener = undefined;
    }
    entry.resolve(result);
  }
}
