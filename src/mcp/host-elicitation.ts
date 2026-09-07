import type {
  ElicitRequestFormParams,
  ElicitRequestParams,
  ElicitResult,
} from "@modelcontextprotocol/client";
import type { ExtensionContext } from "@sammorrowdrums/mcpi";
import type { McpElicitationHandler } from "./client-factory.js";

type ElicitationContext = Pick<ExtensionContext, "hasUI" | "ui">;
type ElicitationValue = string | number | boolean | string[];

export class McpHostElicitationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpHostElicitationError";
  }
}

/**
 * Bridges MCP form elicitation to mcpi's explicit user-facing UI.
 *
 * URL elicitation is intentionally unsupported and is not advertised by the
 * client. Form requests never receive an implicit approval.
 */
export class McpiHostElicitation implements McpElicitationHandler {
  private context: ElicitationContext | undefined;

  setContext(context: ElicitationContext | undefined): void {
    this.context = context;
  }

  async elicit(params: ElicitRequestParams): Promise<ElicitResult> {
    if (params.mode === "url") {
      throw new McpHostElicitationError(
        `MCP URL elicitation is unsupported. Open the requested URL manually only after reviewing it: ${params.url}`,
      );
    }

    const context = this.context;
    if (!context?.hasUI) {
      throw new McpHostElicitationError(
        "The MCP server requested user input, but mcpi has no interactive UI. Re-run this call in interactive mode; the request was not approved.",
      );
    }

    const decision = await context.ui.select(params.message, [
      "Provide input",
      "Decline",
      "Cancel",
    ]);

    if (decision === "Decline") {
      return { action: "decline" };
    }
    if (decision !== "Provide input") {
      return { action: "cancel" };
    }

    let draft = JSON.stringify(buildInitialContent(params), null, 2);
    while (true) {
      const edited = await context.ui.editor("MCP input required (JSON)", draft);
      if (edited === undefined) {
        return { action: "cancel" };
      }

      try {
        const content: unknown = JSON.parse(edited);
        if (!isElicitationContent(content)) {
          context.ui.notify(
            "MCP elicitation input must be a JSON object containing primitive values or string arrays.",
            "error",
          );
          draft = edited;
          continue;
        }
        return { action: "accept", content };
      } catch {
        context.ui.notify("MCP elicitation input must be valid JSON.", "error");
        draft = edited;
      }
    }
  }
}

function buildInitialContent(params: ElicitRequestFormParams): Record<string, ElicitationValue> {
  return Object.fromEntries(
    Object.entries(params.requestedSchema.properties).map(([name, definition]) => [
      name,
      initialValue(definition),
    ]),
  );
}

function initialValue(
  definition: ElicitRequestFormParams["requestedSchema"]["properties"][string],
): ElicitationValue {
  if (definition.default !== undefined) {
    return definition.default;
  }
  if (definition.type === "boolean") {
    return false;
  }
  if (definition.type === "number" || definition.type === "integer") {
    return definition.minimum ?? 0;
  }
  if (definition.type === "array") {
    return [];
  }
  if ("enum" in definition) {
    return definition.enum[0] ?? "";
  }
  if ("oneOf" in definition) {
    return definition.oneOf[0]?.const ?? "";
  }
  return "";
}

function isElicitationContent(value: unknown): value is Record<string, ElicitationValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (entry) =>
        typeof entry === "string" ||
        typeof entry === "number" ||
        typeof entry === "boolean" ||
        (Array.isArray(entry) && entry.every((item) => typeof item === "string")),
    )
  );
}
