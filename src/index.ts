import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { dockerE2ETool } from "./docker-e2e.js";

export default function (pi: ExtensionAPI) {
  pi.registerTool(dockerE2ETool);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.notify("pi-mcp-agent loaded", "info");
    }
  });
}
