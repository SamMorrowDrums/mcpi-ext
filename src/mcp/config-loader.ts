import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { McpConfig } from "./config.js";

const DEFAULT_CONFIG_PATH = join(homedir(), ".config", "pi-mcp-agent", "mcp.json");

/**
 * Load and validate an MCP config file.
 * Returns an empty config if the file doesn't exist.
 * Throws on invalid JSON or schema violations.
 */
export async function loadMcpConfig(configPath?: string): Promise<McpConfig> {
  const path = configPath ?? DEFAULT_CONFIG_PATH;

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { mcpServers: {} };
    }
    throw new Error(`Failed to read MCP config at ${path}: ${(err as Error).message}`, {
      cause: err,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Invalid JSON in MCP config at ${path}`);
  }

  if (!Value.Check(McpConfig, parsed)) {
    const errors = Value.Errors(McpConfig, parsed);
    const details = errors
      .slice(0, 5)
      .map((e) => `  ${e.instancePath || "/"}: ${e.message}`)
      .join("\n");
    throw new Error(`Invalid MCP config at ${path}:\n${details}`);
  }

  return parsed;
}
